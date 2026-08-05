import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import type { KvmCredentials, MouseMode, PowerCommand } from '@shared/types';
import { AppError, msg, type Message } from '@shared/i18n';
import {
  Bandwidth,
  IVTP_HEADER_SIZE,
  MouseModeCode,
  Pkt,
  PowerControl,
  StopReason,
  buildBandwidthPacket,
  buildControl,
  buildValidatePacket,
  buildWebTokenPacket,
  readHeader,
} from './ivtp';

/**
 * The KVM session: a TCP connection to the BMC, IVTP stream parsing and video
 * frame assembly.
 *
 * Session setup order (verified against a live BMC):
 *   1. TCP connect, the client stays quiet;
 *   2. the server sends SESSION_ACCEPTED (23);
 *   3. the client answers with GET_WEB_TOKEN (21),
 *      VALIDATE_VIDEO_SESSION (18) and RESUME_REDIRECTION (6);
 *   4. the server answers VALIDATE_VIDEO_SESSION_RESPONSE (19) — one byte,
 *      where 0 means refusal.
 * Input is only allowed after step 4.
 */

/** 1920*1200*4 — the frame size ceiling, as in the original FragReader. */
const MAX_FRAME_BYTES = 9_216_000;

export interface KvmSessionOptions {
  /**
   * Accept the BMC's self-signed certificate when kvmsecure=1.
   *
   * Defaults to true: BMC certificates are almost always self-signed, and
   * with verification the connection never comes up. The original JViewer
   * behaves the same way (a trust-all X509TrustManager in its Client.java).
   * Set it to false when the BMC certificate is issued by your own CA.
   */
  insecureTls?: boolean;
}

/** BMC service details from the CONF_SERVICE_STATUS packet. */
export interface ServiceInfo {
  name: string;
  /** The service is enabled and its port can be connected to. */
  enabled: boolean;
  port: number;
  securePort: number;
}

export interface KvmSessionEvents {
  connected: [];
  authenticated: [];
  /** Current BMC service ports and limits. */
  services: [ServiceInfo[]];
  /** An assembled frame: 13-byte header + compressed data. */
  frame: [Buffer];
  blankScreen: [];
  mouseMode: [MouseMode];
  powerStatus: [boolean];
  powerResponse: [{ ok: boolean; code: number }];
  keyboardLeds: [number];
  activeClients: [string[]];
  closed: [Message];
  error: [Error];
}

const POWER_COMMAND_CODES: Record<PowerCommand, number> = {
  'off-immediate': PowerControl.OFF_IMMEDIATE,
  on: PowerControl.ON,
  cycle: PowerControl.CYCLE,
  'hard-reset': PowerControl.HARD_RESET,
  'orderly-shutdown': PowerControl.SOFT_RESET,
};

const MOUSE_MODES: Record<number, MouseMode> = {
  [MouseModeCode.RELATIVE]: 'relative',
  [MouseModeCode.ABSOLUTE]: 'absolute',
  [MouseModeCode.OTHER]: 'other',
};

export class KvmSession extends EventEmitter<KvmSessionEvents> {
  private socket: net.Socket | null = null;
  private rx: Buffer = Buffer.alloc(0);

  /** Fragment accumulator for the current frame. */
  private frameParts: Buffer[] = [];
  private frameBytes = 0;

  private authenticated = false;
  private closing = false;

  /** The socket's local IP — it goes into the validation packet. */
  private clientIp = '';

  private mouseMode: MouseMode = 'absolute';

  constructor(
    private readonly credentials: KvmCredentials,
    private readonly options: KvmSessionOptions = {},
  ) {
    super();
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  get currentMouseMode(): MouseMode {
    return this.mouseMode;
  }

  connect(): void {
    const { host, kvmPort, kvmSecure } = this.credentials;

    const onConnect = () => {
      const local = this.socket?.localAddress ?? '';
      // Node reports an IPv4-mapped address like ::ffff:10.0.0.5 — the BMC
      // expects plain IPv4.
      this.clientIp = local.replace(/^::ffff:/, '');
      this.emit('connected');
    };

    this.socket = kvmSecure
      ? tls.connect(
          {
            host,
            port: kvmPort,
            rejectUnauthorized: !(this.options.insecureTls ?? true),
            minVersion: 'TLSv1.2',
          },
          onConnect,
        )
      : net.connect({ host, port: kvmPort }, onConnect);

    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (err: Error) => this.emit('error', err));
    this.socket.on('close', () => {
      if (!this.closing) this.emit('closed', msg('kvm.disconnected'));
    });
  }

  close(reason: Message = msg('kvm.sessionClosed')): void {
    if (this.closing) return;
    this.closing = true;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(buildControl(Pkt.STOP_SESSION_IMMEDIATE));
      } catch {
        // The socket may already be dead — it does not matter.
      }
      this.socket.destroy();
    }
    this.emit('closed', reason);
  }

  /** Sends a prepared packet (used by the HID module). */
  send(packet: Buffer): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(packet);
  }

  requestPowerStatus(): void {
    this.send(buildControl(Pkt.POWER_STATUS));
  }

  sendPowerCommand(command: PowerCommand): void {
    this.send(buildControl(Pkt.POWER_CONTROL_REQUEST, POWER_COMMAND_CODES[command]));
  }

  requestFullScreen(): void {
    this.send(buildControl(Pkt.GET_FULL_SCREEN));
  }

  clearVideoBuffer(): void {
    this.send(buildControl(Pkt.CLEAR_VIDEO_BUFFER));
  }

  setMouseMode(mode: MouseMode): void {
    const code =
      mode === 'relative'
        ? MouseModeCode.RELATIVE
        : mode === 'absolute'
          ? MouseModeCode.ABSOLUTE
          : MouseModeCode.OTHER;
    this.send(buildControl(Pkt.SET_MOUSE_MODE, code));
  }

  requestKeyboardLeds(): void {
    this.send(buildControl(Pkt.GET_KEYBD_LED));
  }

  pause(): void {
    this.send(buildControl(Pkt.PAUSE_REDIRECTION));
  }

  resume(): void {
    this.send(buildControl(Pkt.RESUME_REDIRECTION));
  }

  private onData(chunk: Buffer): void {
    this.rx = this.rx.length === 0 ? chunk : Buffer.concat([this.rx, chunk]);

    while (this.rx.length >= IVTP_HEADER_SIZE) {
      const header = readHeader(this.rx);

      if (header.pktSize < 0) {
        this.emit('error', new AppError('kvm.badPacketLength', { size: header.pktSize }));
        this.close(msg('kvm.protocolError'));
        return;
      }
      if (this.rx.length < IVTP_HEADER_SIZE + header.pktSize) return;

      const body = this.rx.subarray(IVTP_HEADER_SIZE, IVTP_HEADER_SIZE + header.pktSize);
      // Copy: subarray shares memory with rx, which is about to be dropped.
      const payload = Buffer.from(body);
      this.rx = this.rx.subarray(IVTP_HEADER_SIZE + header.pktSize);

      this.handlePacket(header.type, header.status, payload);
    }
  }

  private handlePacket(type: number, status: number, body: Buffer): void {
    switch (type) {
      case Pkt.SESSION_ACCEPTED:
        this.sendHandshake();
        break;

      case Pkt.VALIDATE_VIDEO_SESSION_RESPONSE:
        if (body.length > 0 && body[0] !== 0) {
          this.authenticated = true;
          this.emit('authenticated');
          // The original client immediately asks for power and sets bandwidth.
          this.requestPowerStatus();
          this.send(buildBandwidthPacket(Bandwidth.MBPS_100));
        } else {
          this.emit('error', new AppError('kvm.tokenRejected'));
          this.close(msg('kvm.authFailed'));
        }
        break;

      case Pkt.VIDEO_FRAGMENT:
        this.onVideoFragment(body);
        break;

      case Pkt.BLANK_SCREEN:
        this.emit('blankScreen');
        break;

      case Pkt.GET_USB_MOUSE_MODE:
        if (body.length > 0) {
          const mode = MOUSE_MODES[body[0]];
          if (mode) {
            this.mouseMode = mode;
            this.emit('mouseMode', mode);
          }
        }
        break;

      case Pkt.MOUSE_MEDIA_INFO:
        // The first byte is the mouse mode, then virtual media counters.
        if (body.length > 0) {
          const mode = MOUSE_MODES[body[0]];
          if (mode) {
            this.mouseMode = mode;
            this.emit('mouseMode', mode);
          }
        }
        break;

      case Pkt.GET_KEYBD_LED:
        if (body.length > 0) this.emit('keyboardLeds', body[0]);
        break;

      case Pkt.POWER_STATUS:
        // The status arrives in the header's status field; there is no body.
        this.emit('powerStatus', status === 1);
        break;

      case Pkt.POWER_CONTROL_RESPONSE:
        this.emit('powerResponse', { ok: status === 0, code: status });
        break;

      case Pkt.GET_ACTIVE_CLIENTS:
        this.emit('activeClients', parseActiveClients(body));
        break;

      case Pkt.CONF_SERVICE_STATUS:
        this.emit('services', parseServices(body));
        break;

      case Pkt.MAX_SESSION_CLOSING:
        this.close(msg('kvm.sessionLimit'));
        break;

      case Pkt.STOP_SESSION_IMMEDIATE:
        this.close(describeStopReason(status));
        break;

      case Pkt.KVM_SOCKET_STATUS:
        this.close(msg('kvm.closedByOther'));
        break;

      default:
        // The remaining packets (service configuration, KVM sharing,
        // encryption status) do not affect how the console works.
        break;
    }
  }

  /**
   * Three packets in reply to SESSION_ACCEPTED. The order matters: the BMC
   * expects the web session cookie before the token, and without
   * RESUME_REDIRECTION it never starts sending video.
   */
  private sendHandshake(): void {
    const { webCookie, kvmToken } = this.credentials;
    this.send(buildWebTokenPacket(webCookie));
    this.send(buildValidatePacket(kvmToken, this.clientIp));
    this.send(buildControl(Pkt.RESUME_REDIRECTION));
  }

   /**
   * A frame arrives in fragments: body = u16 LE fragment number + data.
   * The low 15 bits are zero on the first fragment, and bit 15 marks the last.
   */
  private onVideoFragment(body: Buffer): void {
    if (body.length < 2) return;

    const fragNum = body.readUInt16LE(0);
    const data = body.subarray(2);

    if ((fragNum & 0x7fff) === 0) {
      this.frameParts = [];
      this.frameBytes = 0;
    }

    if (this.frameBytes + data.length > MAX_FRAME_BYTES) {
      // Lost the start of the frame, or the BMC went haywire — ask for a
      // full frame again.
      this.frameParts = [];
      this.frameBytes = 0;
      this.requestFullScreen();
      return;
    }

    this.frameParts.push(data);
    this.frameBytes += data.length;

    if (fragNum & 0x8000) {
      const frame = Buffer.concat(this.frameParts, this.frameBytes);
      this.frameParts = [];
      this.frameBytes = 0;
      this.emit('frame', frame);
    }
  }
}

function describeStopReason(status: number): Message {
  switch (status) {
    case StopReason.ENGINE_CLOSING:
      return msg('kvm.closedByBmc');
    case StopReason.INVALID_VIDEO_TOKEN:
      return msg('kvm.videoTokenRejected');
    case StopReason.CONF_CHANGED:
      return msg('kvm.settingsChanged');
    case StopReason.WEB_LOGOUT:
      return msg('kvm.webLogout');
    default:
      return msg('kvm.closedWithCode', { status });
  }
}

/**
 * The CONF_SERVICE_STATUS packet: five BMC service records
 * (web, kvm, cd-media, fd-media, hd-media, in that order).
 *
 * The record layout was taken from a real exchange (see
 * scripts/dump-services.ts) rather than from JViewer's ConfPkt.java: in the
 * decompiled code a record is 51 bytes with 16-bit ports, while the BMC sends
 * 55 bytes with 32-bit ports.
 *
 *   0..15  service name (ASCII)
 *   16     enabled flag
 *   17..32 network interface name
 *   33..36 non-secure port (u32 LE)
 *   37..40 secure port (u32 LE)
 *   41..44 session inactivity timeout (u32 LE, 0xFFFFFFFF — unset)
 *
 * This is the only trustworthy source of the virtual media ports: in the JNLP
 * the BMC substitutes 0x7FFFFFFE for services that are not configured.
 */
function parseServices(body: Buffer): ServiceInfo[] {
  const RECORD = 55;
  const services: ServiceInfo[] = [];

  for (let offset = 0; offset + RECORD <= body.length; offset += RECORD) {
    const name = body
      .subarray(offset, offset + 16)
      .toString('ascii')
      .replace(/\0.*$/s, '')
      .trim();

    const port = body.readUInt32LE(offset + 33);
    const securePort = body.readUInt32LE(offset + 37);

    services.push({
      name,
      // A service with no name or an out-of-range port is not configured.
      enabled: body.readUInt8(offset + 16) !== 0 && name.length > 0 && isValidPort(port),
      port: isValidPort(port) ? port : 0,
      securePort: isValidPort(securePort) ? securePort : 0,
    });
  }

  return services;
}

function isValidPort(port: number): boolean {
  return port > 0 && port < 65536;
}

/** 97-byte records: 64 bytes of user name and 33 bytes of IP. */
function parseActiveClients(body: Buffer): string[] {
  const RECORD = 97;
  const clients: string[] = [];
  for (let offset = 0; offset + RECORD <= body.length; offset += RECORD) {
    const trim = (buf: Buffer) => buf.toString('ascii').replace(/\0.*$/s, '').trim();
    const user = trim(body.subarray(offset, offset + 64));
    const ip = trim(body.subarray(offset + 64, offset + RECORD));
    if (user || ip) clients.push(`${user} : ${ip}`);
  }
  return clients;
}
