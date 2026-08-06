import type { BrowserWindow } from 'electron';
import type { KeyEventPayload, MouseMode, PowerCommand } from '@shared/types';
import { DEFAULT_ADVANCED, type AdvancedSettings } from '@shared/settings';
import { IpcChannel, type ConnectRequest, type KvmEvent } from '@shared/ipc';
import { msg } from '@shared/i18n';
import { connect as bmcConnect, logout, type BmcSession } from '../bmc/auth';
import { KvmSession, type ServiceInfo } from './session';
import { KeyboardState, MouseState } from './hid';
import { Pkt, buildControl } from './ivtp';

function isUsablePort(port: number | undefined): boolean {
  return port !== undefined && port > 0 && port < 65536;
}

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

  constructor(private readonly window: BrowserWindow) {}

  get mouseMode(): MouseMode {
    return this.session?.currentMouseMode ?? 'absolute';
  }

  /**
   * Parameters for a separate Virtual Media connection.
   *
   * The CD-ROM port comes from the service configuration packet: in the JNLP
   * the BMC substitutes 0x7FFFFFFE when the slot is taken by another client,
   * and that value is unusable.
   */
  get connectionInfo(): { host: string; cdPort: number; token: string } | null {
    if (!this.credentials) return null;

    // The third record is cd-media; the service order in the packet is fixed.
    const fromServices = this.services[2];
    const jnlpPort = this.credentials.cdPort;
    const cdPort = isUsablePort(fromServices?.port)
      ? fromServices!.port
      : isUsablePort(jnlpPort)
        ? jnlpPort
        : this.settings.cdPort;

    return { host: this.credentials.host, cdPort, token: this.credentials.kvmToken };
  }

  /**
   * Whether the BMC has the CD redirection service configured.
   *
   * CONF_SERVICE_STATUS records come in a fixed order (web, kvm, cd-media,
   * fd-media, hd-media), and an inactive service has an empty name and a port
   * of 0xFFFFFFFE — hence the lookup by position rather than by name.
   */
  get isCdMediaAvailable(): boolean {
    const cd = this.services[2];
    return cd !== undefined && cd.enabled;
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
    });
    kvm.on('error', (err) => {
      this.emit({ type: 'status', status: { kind: 'error', message: err.message } });
    });
    kvm.on('closed', (reason) => {
      this.emit({ type: 'status', status: { kind: 'closed', reason } });
      void this.cleanup();
    });

    kvm.connect();
  }

  async disconnect(): Promise<void> {
    this.session?.close(msg('kvm.disconnectedByUser'));
    await this.cleanup();
    this.emit({ type: 'status', status: { kind: 'idle' } });
  }

  sendPower(command: PowerCommand): void {
    this.session?.sendPowerCommand(command);
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
