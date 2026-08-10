/**
 * IUSB protocol framing (Virtual Media, ports 5120/5122/5123).
 *
 * A packet is a 32-byte header plus a payload of dataPacketLen bytes, which
 * begins with a SCSI structure whose byte 9 coincides with byte 0 of the CDB.
 * The header layout comes from JViewer's IUSBHeader.java; the structure
 * layout, which JViewer leaves to a native library, was recovered from that
 * library (libjavaharddiskwrapper / libjavacdromwrapper, ExecuteSCSICmd and
 * SetErrorStatus) and confirmed against a live BMC:
 *
 *   0..3    length of the data the BMC expects (echoed back untouched)
 *   4..7    transfer tag, incremented by the BMC (echoed back untouched)
 *   8       always 1 (echoed back untouched)
 *   9..24   CDB, up to 16 bytes
 *   21..24  in a REPLY these four bytes are overwritten with the result:
 *           an error flag, then the sense key and the additional codes
 *   25..28  in a REPLY, the length of the data actually transferred (u32 LE)
 *   29..    the data itself
 *
 * That the status overlaps the tail of the CDB is not a mistake: the native
 * library writes it exactly there, over a CDB it has already parsed.
 */

import { ScsiStatus } from './scsi';

export const IUSB_HEADER_SIZE = 32;

/** Size of the SCSI structure preceding the data inside the payload. */
export const IUSB_SCSI_STRUCT_SIZE = 29;

/**
 * Offset of the connection status in an authentication reply.
 *
 * The auth exchange predates the SCSI structure and uses a fixed layout of its
 * own: JViewer reads the status at 30 and the address of the other client at
 * 31, regardless of how long the SCSI structure is.
 */
const AUTH_STATUS_OFFSET = 30;

/** Offset of the CDB inside the payload. */
export const CDB_OFFSET = 9;

/** Maximum CDB length. */
export const CDB_MAX_LENGTH = 16;

export const IUSB_SIGNATURE = Buffer.from('IUSB    ', 'ascii');

/** Housekeeping codes that occupy the opcode field instead of a SCSI command. */
export const IusbOpcode = {
  REDIRECTION_ACK: 0xf1,
  AUTH: 0xf2,
  SET_HARDDISK_TYPE: 0xf4,
} as const;

/** The connectionStatus value in an authentication reply. */
export const CONNECTION_ACCEPTED = 1;

export const DeviceType = {
  CDROM: 5,
  FLOPPY: 6,
  HARDDISK: 7,
} as const;

export interface IusbHeader {
  dataPacketLen: number;
  serverCaps: number;
  deviceType: number;
  protocol: number;
  direction: number;
  deviceNumber: number;
  interfaceNumber: number;
  clientData: number;
  instance: number;
  sequenceNumber: number;
}

export interface IusbPacket {
  header: IusbHeader;
  payload: Buffer;
  /** The packet as it arrived — a reply is built by editing a copy of it. */
  raw: Buffer;
  /** CDB byte 0 — also the housekeeping code on non-SCSI packets. */
  opcode: number;
  cdb: Buffer;
}

export function buildIusbHeader(options: {
  dataPacketLen: number;
  deviceType?: number;
  instance?: number;
  sequenceNumber?: number;
  deviceNumber?: number;
  interfaceNumber?: number;
  clientData?: number;
}): Buffer {
  const header = Buffer.alloc(IUSB_HEADER_SIZE);
  IUSB_SIGNATURE.copy(header, 0);
  header.writeUInt8(1, 8); // major
  header.writeUInt8(0, 9); // minor
  header.writeUInt8(IUSB_HEADER_SIZE, 10);
  header.writeUInt8(0, 11); // checksum, filled in by writeHeaderChecksum
  header.writeUInt32LE(options.dataPacketLen, 12);
  header.writeUInt8(0, 16); // serverCaps
  header.writeUInt8(options.deviceType ?? DeviceType.CDROM, 17);
  header.writeUInt8(1, 18); // protocol
  header.writeUInt8(0x80, 19); // direction: always "from the client"
  header.writeUInt8(options.deviceNumber ?? 0, 20);
  header.writeUInt8(options.interfaceNumber ?? 0, 21);
  header.writeUInt8(options.clientData ?? 0, 22);
  header.writeUInt8(options.instance ?? 0, 23);
  header.writeUInt32LE(options.sequenceNumber ?? 0, 24);
  writeHeaderChecksum(header);
  return header;
}

/**
 * Byte 11 of the header, chosen so that bytes 0..27 sum to zero.
 *
 * The last four bytes stay out of the sum: they are opaque to us — the BMC
 * puts what looks like one of its own pointers there and wants it back
 * untouched — and leaving them out is what makes the checksums the BMC itself
 * sends add up.
 *
 * The BMC does not verify the field (it accepts a zero there quite happily),
 * so this is a courtesy rather than a requirement.
 */
function writeHeaderChecksum(header: Buffer): void {
  header.writeUInt8(0, 11);
  let sum = 0;
  for (let i = 0; i < 28; i++) sum += header[i];
  header.writeUInt8((0x100 - (sum & 0xff)) & 0xff, 11);
}

export function parseIusbPacket(buf: Buffer): IusbPacket | null {
  if (buf.length < IUSB_HEADER_SIZE) return null;
  if (!buf.subarray(0, 8).equals(IUSB_SIGNATURE)) return null;

  const dataPacketLen = buf.readUInt32LE(12);
  if (buf.length < IUSB_HEADER_SIZE + dataPacketLen) return null;

  const payload = buf.subarray(IUSB_HEADER_SIZE, IUSB_HEADER_SIZE + dataPacketLen);
  return {
    header: {
      dataPacketLen,
      serverCaps: buf.readUInt8(16),
      deviceType: buf.readUInt8(17),
      protocol: buf.readUInt8(18),
      direction: buf.readUInt8(19),
      deviceNumber: buf.readUInt8(20),
      interfaceNumber: buf.readUInt8(21),
      clientData: buf.readUInt8(22),
      instance: buf.readUInt8(23),
      sequenceNumber: buf.readUInt32LE(24),
    },
    payload,
    raw: buf,
    opcode: payload.length > CDB_OFFSET ? payload.readUInt8(CDB_OFFSET) : 0,
    cdb: payload.subarray(CDB_OFFSET, CDB_OFFSET + CDB_MAX_LENGTH),
  };
}

/**
 * The authentication packet: 160 bytes carrying the KVM session token in the
 * clear. The very same token as KVM uses — Virtual Media has none of its own.
 */
export function buildAuthPacket(token: string, instance = 0, deviceType: number = DeviceType.CDROM): Buffer {
  const AUTH_PAYLOAD_SIZE = 128;
  const packet = Buffer.alloc(IUSB_HEADER_SIZE + AUTH_PAYLOAD_SIZE);
  buildIusbHeader({ dataPacketLen: AUTH_PAYLOAD_SIZE, deviceType, instance }).copy(packet, 0);
  packet.writeUInt8(IusbOpcode.AUTH, IUSB_HEADER_SIZE + CDB_OFFSET);
  // The token sits where the reply carries the connection status, after one
  // zero byte.
  packet.writeUInt8(0, IUSB_HEADER_SIZE + AUTH_STATUS_OFFSET);
  packet.write(token, IUSB_HEADER_SIZE + AUTH_STATUS_OFFSET + 1, 'ascii');
  return packet;
}

export interface AuthResult {
  accepted: boolean;
  /** IP of the client already holding the redirect (when refused). */
  otherIp: string;
}

export function parseAuthAck(packet: IusbPacket): AuthResult {
  const status = packet.payload.length > AUTH_STATUS_OFFSET
    ? packet.payload.readUInt8(AUTH_STATUS_OFFSET)
    : 0;
  const otherIp = packet.payload
    .subarray(AUTH_STATUS_OFFSET + 1, AUTH_STATUS_OFFSET + 25)
    .toString('ascii')
    .replace(/\0.*$/s, '')
    .trim();
  return { accepted: status === CONNECTION_ACCEPTED, otherIp };
}

/**
 * The reply to a SCSI command.
 *
 * The request is mirrored back and only the result fields are overwritten:
 * everything else the BMC sent — the tag, the trailing four header bytes it
 * treats as its own — has to come back exactly as it went out, or the BMC does
 * not recognise the reply as belonging to its request and repeats the command
 * once a second forever.
 */
export function buildScsiResponse(
  request: IusbPacket,
  result: { status: number; data: Buffer; sense: { key: number; asc: number; ascq: number } | null },
): Buffer {
  const payload = Buffer.alloc(IUSB_SCSI_STRUCT_SIZE + result.data.length);

  // Use the request's SCSI structure as the basis of the reply.
  request.payload.copy(payload, 0, 0, Math.min(IUSB_SCSI_STRUCT_SIZE, request.payload.length));

  // The result goes over the tail of the CDB: a flag rather than a SCSI status
  // byte (the BMC turns it into CHECK CONDITION itself), then the sense data.
  payload.writeUInt8(result.status === ScsiStatus.GOOD ? 0 : 1, 21);
  payload.writeUInt8(result.sense?.key ?? 0, 22);
  payload.writeUInt8(result.sense?.asc ?? 0, 23);
  payload.writeUInt8(result.sense?.ascq ?? 0, 24);
  // How much data actually follows the structure.
  payload.writeUInt32LE(result.data.length, 25);

  result.data.copy(payload, IUSB_SCSI_STRUCT_SIZE);

  const header = Buffer.alloc(IUSB_HEADER_SIZE);
  request.raw.copy(header, 0, 0, IUSB_HEADER_SIZE);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt8(0x80, 19); // direction: the reply always travels one way
  writeHeaderChecksum(header);

  return Buffer.concat([header, payload]);
}
