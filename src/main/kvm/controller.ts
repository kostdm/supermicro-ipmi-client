import type { BrowserWindow } from 'electron';
import type {
  KeyEventPayload,
  MouseMode,
  PowerCommand,
  VirtualMediaKind,
  VirtualMediaServices,
} from '@shared/types';
import { DEFAULT_ADVANCED, type AdvancedSettings } from '@shared/settings';
import { IpcChannel, type ConnectRequest, type KvmEvent } from '@shared/ipc';
import { AppError, msg } from '@shared/i18n';
import { connect as bmcConnect, logout, type BmcSession } from '../bmc/auth';
import type { IpmiController } from '../ipmi/controller';
import { KvmSession, type ServiceInfo } from './session';
import { KeyboardState, MouseState } from './hid';
import { Pkt, buildControl } from './ivtp';

function isUsablePort(port: number | undefined): boolean {
  return port !== undefined && port > 0 && port < 65536;
}

/** The factory port of hd-media; there is no setting for it. */
const DEFAULT_HD_PORT = 5123;

/**
 * Ties the web login, the KVM session and the application window together.
 *
 * Exactly one session is kept alive: the BMC limits how many can run at once,
 * and a second session from the same application would only steal a slot.
 */
export class KvmController {
  private session: KvmSession | null = null;
  private webSession: BmcSession | null = null;
  private keyboard = new KeyboardState();
  private mouse = new MouseState();
  private credentials: import('@shared/types').KvmCredentials | null = null;
  private services: ServiceInfo[] = [];
  /** false until the first frame of a session arrives. */
  private videoPresent = false;
  private blankRetry: NodeJS.Timeout | null = null;
  /** Timings and ports of the profile being connected to. */
  private settings: AdvancedSettings = DEFAULT_ADVANCED;
  /** The IPMI session of the same server, when one is open. */
  private ipmi: IpmiController | null = null;
  /** Pending chassis state re-reads after a power command. */
  private powerPolls = new Set<NodeJS.Timeout>();

  constructor(private readonly window: BrowserWindow) {}

  get mouseMode(): MouseMode {
    return this.session?.currentMouseMode ?? 'absolute';
  }

  /**
   * Parameters for a separate Virtual Media connection.
   *
   * The ports come from the service configuration packet: in the JNLP the BMC
   * substitutes 0x7FFFFFFE for a service whose slot is taken by another
   * client, and that value is unusable.
   *
   * CONF_SERVICE_STATUS records come in a fixed order (web, kvm, cd-media,
   * fd-media, hd-media), and a service that is not configured has an empty
   * name and a port of 0xFFFFFFFE — hence the lookup by position rather than
   * by name.
   */
  get connectionInfo(): {
    host: string;
    token: string;
    ports: Record<VirtualMediaKind, number>;
  } | null {
    if (!this.credentials) return null;

    const port = (fromServices: number | undefined, fromJnlp: number, fallback: number) =>
      isUsablePort(fromServices)
        ? fromServices!
        : isUsablePort(fromJnlp)
          ? fromJnlp
          : fallback;

    return {
      host: this.credentials.host,
      token: this.credentials.kvmToken,
      ports: {
        cdrom: port(this.services[2]?.port, this.credentials.cdPort, this.settings.cdPort),
        harddisk: port(this.services[4]?.port, this.credentials.hdPort, DEFAULT_HD_PORT),
      },
    };
  }

  /**
   * Which media services the BMC offers.
   *
   * Not academic: firmware happily ships with a corrupted cd-media entry (an
   * empty interface name and a port of 0xFFFFFFFE) that it then refuses to
   * reconfigure, while hd-media on the same board works. The user has to be
   * able to see that and pick the other one.
   */
  get mediaServices(): VirtualMediaServices {
    return {
      cdrom: this.services[2]?.enabled === true,
      harddisk: this.services[4]?.enabled === true,
    };
  }

  /**
   * Tells the BMC that virtual media is attached or detached.
   * Without this packet the guest system never sees the device.
   */
  notifyMediaState(attached: boolean): void {
    this.session?.send(buildControl(Pkt.MEDIA_STATE, attached ? 1 : 0));
  }

  async connect(request: ConnectRequest): Promise<void> {
    await this.disconnect();

    this.settings = request.advanced;
    this.emit({ type: 'status', status: { kind: 'connecting' } });

    const { session: web, credentials } = await bmcConnect(
      request.host,
      request.username,
      request.password,
      {
        port: request.port,
        insecureTls: this.settings.insecureTls,
        timeoutMs: this.settings.httpTimeoutMs,
      },
    );
    this.webSession = web;
    this.credentials = credentials;

    const kvm = new KvmSession(credentials, {
      insecureTls: this.settings.insecureTls,
      bandwidthBytesPerSecond: this.settings.bandwidthBytesPerSecond,
      handshakeTimeoutMs: this.settings.kvmHandshakeTimeoutMs,
    });
    this.session = kvm;
    this.keyboard = new KeyboardState();
    this.mouse = new MouseState();

    kvm.on('connected', () => {
      this.emit({ type: 'status', status: { kind: 'authenticating' } });
    });
    kvm.on('authenticated', () => {
      this.emit({ type: 'status', status: { kind: 'connected' } });
    });
    kvm.on('frame', (frame) => {
      // A frame is the only proof that the signal is back.
      this.setVideoSignal(true);
      this.sendFrame(frame);
    });
    kvm.on('blankScreen', () => this.setVideoSignal(false));
    kvm.on('mouseMode', (mode) => this.emit({ type: 'mouseMode', mode }));
    kvm.on('powerStatus', (on) => this.emit({ type: 'powerStatus', on }));
    kvm.on('powerResponse', (r) => this.emit({ type: 'powerResponse', ...r }));
    kvm.on('keyboardLeds', (leds) => this.emit({ type: 'keyboardLeds', leds }));
    kvm.on('activeClients', (clients) => this.emit({ type: 'activeClients', clients }));
    kvm.on('services', (services) => {
      this.services = services;
      this.emit({ type: 'mediaServices', services: this.mediaServices });
    });
    kvm.on('error', (err) => {
      this.emit({ type: 'status', status: { kind: 'error', message: err.message } });
    });
    kvm.on('closed', (reason) => {
      this.emit({ type: 'status', status: { kind: 'closed', reason } });
      void this.cleanup();
      // The KVM channel was where the power state came from. It is gone, and
      // the toolbar has just blanked the badge — IPMI can still fill it in.
      void this.refreshPowerState();
    });

    kvm.connect();
  }

  async disconnect(): Promise<void> {
    this.session?.close(msg('kvm.disconnectedByUser'));
    await this.cleanup();
    this.emit({ type: 'status', status: { kind: 'idle' } });
  }

  /**
   * The IPMI session to run power control over. Set once it is open, cleared
   * when it closes.
   */
  useIpmi(ipmi: IpmiController | null): void {
    this.ipmi = ipmi;
    if (ipmi) return;
    for (const timer of this.powerPolls) clearTimeout(timer);
    this.powerPolls.clear();
  }

  /**
   * Power control.
   *
   * IPMI over LAN first, and the KVM channel only as a fallback. The two
   * transports are independent, and the KVM one is precisely the one that
   * fails when the BMC video engine wedges: the connection on port 7578 is
   * accepted, nothing ever answers on it, and a POWER_CONTROL_REQUEST written
   * there vanishes without a word. Someone whose console has just died is the
   * likeliest person to reach for the power menu.
   */
  async sendPower(command: PowerCommand): Promise<void> {
    if (this.ipmi) {
      try {
        await this.ipmi.power(command);
        this.emit({ type: 'powerResponse', ok: true, code: 0 });
        this.trackPowerState();
        return;
      } catch (err) {
        // IPMI over LAN can be switched off on the BMC — try the other route
        // before giving up, and report the IPMI error when there is none.
        if (!this.session?.isAuthenticated) throw err;
      }
    }

    if (!this.session?.isAuthenticated) throw new AppError('error.noPowerChannel');
    this.session.sendPowerCommand(command);
  }

  /**
   * Re-reads the chassis state after a power command.
   *
   * The KVM channel announces POWER_STATUS by itself; over IPMI nobody
   * volunteers it, and the state needs a few seconds to settle — a start takes
   * a moment, an orderly shutdown considerably longer.
   */
  private trackPowerState(): void {
    for (const delay of [2000, 8000, 20_000]) {
      const timer = setTimeout(() => {
        this.powerPolls.delete(timer);
        void this.refreshPowerState();
      }, delay);
      this.powerPolls.add(timer);
    }
  }

  /** Reports the chassis state read over IPMI. Failures stay silent. */
  async refreshPowerState(): Promise<void> {
    if (!this.ipmi) return;
    try {
      this.emit({ type: 'powerStatus', on: await this.ipmi.powerState() });
    } catch {
      // The sensor panel reports IPMI trouble of its own; the power badge
      // simply keeps its previous value.
    }
  }

  refreshScreen(): void {
    this.session?.requestFullScreen();
  }

  /**
   * Tracks whether the server is producing video and drives the retry loop.
   *
   * Only changes are reported: the BMC repeats BLANK_SCREEN, and the renderer
   * would otherwise re-render the indicator on every packet.
   */
  private setVideoSignal(present: boolean): void {
    if (present) this.stopBlankRetry();
    if (this.videoPresent === present) return;

    this.videoPresent = present;
    this.emit({ type: 'videoSignal', present });

    if (!present) {
      this.blankRetry = setInterval(() => {
        this.session?.requestFullScreen();
      }, this.settings.blankRetryMs);
    }
  }

  private stopBlankRetry(): void {
    if (!this.blankRetry) return;
    clearInterval(this.blankRetry);
    this.blankRetry = null;
  }

  setMouseMode(mode: MouseMode): void {
    this.session?.setMouseMode(mode);
  }

  sendKey(payload: KeyEventPayload): void {
    const session = this.session;
    if (!session?.isAuthenticated) return;
    const packet = this.keyboard.handle(payload.code, payload.pressed);
    if (packet) session.send(packet);
  }

  /** Releases every modifier — needed when the window loses focus. */
  resetKeyboard(): void {
    const session = this.session;
    if (!session?.isAuthenticated) return;
    session.send(this.keyboard.reset());
  }

  /** Ctrl+Alt+Del cannot be caught in a browser — send the sequence by hand. */
  sendCtrlAltDel(): void {
    const session = this.session;
    if (!session?.isAuthenticated) return;
    const sequence: Array<[string, boolean]> = [
      ['ControlLeft', true],
      ['AltLeft', true],
      ['Delete', true],
      ['Delete', false],
      ['AltLeft', false],
      ['ControlLeft', false],
    ];
    for (const [code, pressed] of sequence) {
      const packet = this.keyboard.handle(code, pressed);
      if (packet) session.send(packet);
    }
  }

  sendMouse(
    payload: { x: number; y: number; buttons: number; wheel: number },
    screenWidth: number,
    screenHeight: number,
  ): void {
    const session = this.session;
    if (!session?.isAuthenticated) return;

    if (session.currentMouseMode === 'relative') {
      // In relative mode the renderer sends an already computed delta.
      for (const packet of this.mouse.relative(
        payload.x,
        payload.y,
        payload.buttons,
        payload.wheel,
      )) {
        session.send(packet);
      }
      return;
    }

    session.send(
      this.mouse.absolute(
        payload.x,
        payload.y,
        payload.buttons,
        payload.wheel,
        screenWidth,
        screenHeight,
      ),
    );
  }

  private async cleanup(): Promise<void> {
    this.stopBlankRetry();
    this.videoPresent = false;
    this.session?.removeAllListeners();
    this.session = null;
    this.credentials = null;
    this.services = [];

    const web = this.webSession;
    this.webSession = null;
    if (web) await logout(web);
  }

  private emit(event: KvmEvent): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IpcChannel.KvmEvent, event);
  }

  private sendFrame(frame: Buffer): void {
    if (this.window.isDestroyed()) return;
    // A Buffer is structurally cloned as a Uint8Array — the renderer gets an
    // ArrayBuffer back.
    this.window.webContents.send(
      IpcChannel.KvmFrame,
      frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
    );
  }
}
