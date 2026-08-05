/**
 * IUSB protocol framing (Virtual Media, ports 5120/5122/5123).
 *
 * A packet is a 32-byte header plus a payload of dataPacketLen bytes. The
 * first 30 bytes of the payload are a housekeeping SCSI structure whose byte 9
 * coincides with byte 0 of the CDB. The layout was taken from JViewer's
 * IUSBHeader.java and IUSBSCSI.java.
 */

export const IUSB_HEADER_SIZE = 32;

/** Size of the housekeeping SCSI structure inside the payload. */
export const IUSB_SCSI_STRUCT_SIZE = 30;

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
  // Byte 11 is a checksum. The original client computes it over a garbage
  // range and the BMC never verifies it; write a zero.
  header.writeUInt8(0, 11);
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
  return header;
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
  // The token follows the housekeeping structure after one zero byte.
  packet.writeUInt8(0, IUSB_HEADER_SIZE + IUSB_SCSI_STRUCT_SIZE);
  packet.write(token, IUSB_HEADER_SIZE + IUSB_SCSI_STRUCT_SIZE + 1, 'ascii');
  return packet;
}

export interface AuthResult {
  accepted: boolean;
  /** IP of the client already holding the redirect (when refused). */
  otherIp: string;
}

export function parseAuthAck(packet: IusbPacket): AuthResult {
  const status = packet.payload.length > IUSB_SCSI_STRUCT_SIZE
    ? packet.payload.readUInt8(IUSB_SCSI_STRUCT_SIZE)
    : 0;
  const otherIp = packet.payload
    .subarray(IUSB_SCSI_STRUCT_SIZE + 1, IUSB_SCSI_STRUCT_SIZE + 25)
    .toString('ascii')
    .replace(/\0.*$/s, '')
    .trim();
  return { accepted: status === CONNECTION_ACCEPTED, otherIp };
}

/**
 * The reply to a SCSI command.
 *
 * The housekeeping fields of the structure (bytes 0..8 and 25..29) were filled
 * in by a native library in the original, and their meaning cannot be
 * recovered from the decompiled code. So the request structure is copied
 * wholesale and only the fields we do understand are changed: the length of
 * the data transferred, the SCSI status and the sense data. The header is
 * mirrored back as well, which keeps the reply tied to its request (sequence
 * number, device number and the rest).
 */
export function buildScsiResponse(
  request: IusbPacket,
  result: { status: number; data: Buffer; sense: { key: number; asc: number; ascq: number } | null },
): Buffer {
  const payload = Buffer.alloc(IUSB_SCSI_STRUCT_SIZE + result.data.length);

  // Use the request's housekeeping structure as the basis of the reply.
  request.payload.copy(payload, 0, 0, Math.min(IUSB_SCSI_STRUCT_SIZE, request.payload.length));

  // Bytes 0..3 hold the length of the data actually transferred.
  payload.writeUInt32LE(result.data.length, 0);
  // Byte 25 is the SCSI status, then the sense key and additional codes.
  payload.writeUInt8(result.status, 25);
  payload.writeUInt8(result.sense?.key ?? 0, 26);
  payload.writeUInt8(result.sense?.asc ?? 0, 27);
  payload.writeUInt8(result.sense?.ascq ?? 0, 28);
  payload.writeUInt8(0, 29);

  result.data.copy(payload, IUSB_SCSI_STRUCT_SIZE);

  const header = buildIusbHeader({
    dataPacketLen: payload.length,
    deviceType: request.header.deviceType,
    instance: request.header.instance,
    sequenceNumber: request.header.sequenceNumber,
    deviceNumber: request.header.deviceNumber,
    interfaceNumber: request.header.interfaceNumber,
    clientData: request.header.clientData,
  });

  return Buffer.concat([header, payload]);
}
