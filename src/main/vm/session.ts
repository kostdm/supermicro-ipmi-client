import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  DeviceType,
  IUSB_HEADER_SIZE,
  IusbOpcode,
  buildAuthPacket,
  buildScsiResponse,
  parseAuthAck,
  parseIusbPacket,
  type IusbPacket,
} from './iusb';
import { IsoScsiTarget, type DeviceKind } from './scsi';
import { AppError, msg, type Message } from '@shared/i18n';

/**
 * The Virtual Media session: serves an ISO image as a virtual USB CD-ROM.
 *
 * The exchange is strictly synchronous and driven by the BMC: after
 * authentication the client only answers SCSI requests. The protocol has no
 * keepalive.
 */

export interface VirtualMediaEvents {
  connected: [];
  /** Authentication passed, waiting for requests from the BMC. */
  ready: [];
  /** The guest system asked for the medium to be ejected. */
  ejected: [];
  /** Statistics: how many bytes of the image have been served. */
  progress: [number];
  error: [Error];
  closed: [Message];
}

export interface VirtualMediaOptions {
  host: string;
  port: number;
  /** The KVM session token — Virtual Media uses the very same one. */
  token: string;
  isoPath: string;
  /** Device number, when the BMC offers several slots. */
  instance?: number;
  /** Emulated device type: the BMC listens on a different port for each. */
  kind?: DeviceKind;
}

export class VirtualMediaSession extends EventEmitter<VirtualMediaEvents> {
  private socket: net.Socket | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private target: IsoScsiTarget;
  private authenticated = false;
  private closing = false;
  private bytesServed = 0;

  constructor(private readonly options: VirtualMediaOptions) {
    super();
    this.target = new IsoScsiTarget(options.isoPath, options.kind ?? 'cdrom');
  }

  get isReady(): boolean {
    return this.authenticated;
  }

  get servedBytes(): number {
    return this.bytesServed;
  }

  connect(): void {
    this.target.open();

    this.socket = net.connect({ host: this.options.host, port: this.options.port }, () => {
      this.emit('connected');
      const deviceType =
        this.options.kind === 'harddisk' ? DeviceType.HARDDISK : DeviceType.CDROM;
      this.socket?.write(
        buildAuthPacket(this.options.token, this.options.instance ?? 0, deviceType),
      );
    });

    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => {
      if (!this.closing) this.close(msg('vm.disconnected'));
    });
  }

  close(reason: Message = msg('vm.detached')): void {
    if (this.closing) return;
    this.closing = true;
    this.authenticated = false;
    this.target.close();
    this.socket?.destroy();
    this.socket = null;
    this.emit('closed', reason);
  }

  private onData(chunk: Buffer): void {
    this.rx = this.rx.length === 0 ? chunk : Buffer.concat([this.rx, chunk]);

    while (this.rx.length >= IUSB_HEADER_SIZE) {
      const dataLen = this.rx.readUInt32LE(12);
      const total = IUSB_HEADER_SIZE + dataLen;
      if (this.rx.length < total) return;

      const packet = parseIusbPacket(this.rx.subarray(0, total));
      this.rx = this.rx.subarray(total);

      if (!packet) {
        this.emit('error', new AppError('vm.badIusbPacket'));
        this.close(msg('vm.protocolError'));
        return;
      }
      this.handlePacket(packet);
    }
  }

  private handlePacket(packet: IusbPacket): void {
    if (packet.opcode === IusbOpcode.REDIRECTION_ACK) {
      const ack = parseAuthAck(packet);
      if (!ack.accepted) {
        this.close(ack.otherIp ? msg('vm.busy', { ip: ack.otherIp }) : msg('vm.refused'));
        return;
      }
      this.authenticated = true;
      this.emit('ready');
      return;
    }

    if (!this.authenticated) {
      // Before authentication is confirmed the BMC should send no commands.
      return;
    }

    const result = this.target.execute(packet.cdb);

    // START STOP UNIT with the eject bit: the guest "took the disc out".
    if (packet.cdb[0] === 0x1b && (packet.cdb[4] & 0x02) !== 0) {
      this.emit('ejected');
    }

    if (result.data.length > 0) {
      this.bytesServed += result.data.length;
      this.emit('progress', this.bytesServed);
    }

    this.socket?.write(buildScsiResponse(packet, result));
  }
}
