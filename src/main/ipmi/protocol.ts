/**
 * Building and parsing RMCP+ packets (IPMI 2.0).
 *
 * Datagram structure:
 *   RMCP header (4 bytes)
 *   authentication format (1) = 0x06 for RMCP+
 *   payload type (1)
 *   session id (4, LE)
 *   session sequence number (4, LE)
 *   payload length (2, LE)
 *   payload
 *   [padding and integrity code — session packets only]
 *
 * The low-level diagnostics below stay in English: they name protocol
 * conditions and end up in logs rather than in the interface.
 */

export const RMCP_VERSION = 0x06;
export const RMCP_CLASS_IPMI = 0x07;
/** Packets outside a session are not numbered. */
export const RMCP_SEQ_NO_ACK = 0xff;

export const AUTH_TYPE_RMCP_PLUS = 0x06;

/** The IPMI over LAN port. */
export const IPMI_PORT = 623;

export const PayloadType = {
  IPMI: 0x00,
  SOL: 0x01,
  OPEN_SESSION_REQUEST: 0x10,
  OPEN_SESSION_RESPONSE: 0x11,
  RAKP_1: 0x12,
  RAKP_2: 0x13,
  RAKP_3: 0x14,
  RAKP_4: 0x15,
} as const;

/** Flags in the high bits of the payload type byte. */
const PAYLOAD_ENCRYPTED = 0x80;
const PAYLOAD_AUTHENTICATED = 0x40;

export const NetFn = {
  CHASSIS: 0x00,
  BRIDGE: 0x02,
  SENSOR: 0x04,
  APP: 0x06,
  STORAGE: 0x0a,
  TRANSPORT: 0x0c,
} as const;

export const PrivilegeLevel = {
  CALLBACK: 1,
  USER: 2,
  OPERATOR: 3,
  ADMINISTRATOR: 4,
} as const;

/** The BMC address on the IPMB bus. */
const BMC_ADDRESS = 0x20;
/** The remote console address (software ID). */
const REMOTE_CONSOLE_ADDRESS = 0x81;

export interface RmcpPacket {
  payloadType: number;
  sessionId: number;
  sessionSequence: number;
  payload: Buffer;
  encrypted: boolean;
  authenticated: boolean;
}

export function buildRmcpHeader(): Buffer {
  return Buffer.from([RMCP_VERSION, 0x00, RMCP_SEQ_NO_ACK, RMCP_CLASS_IPMI]);
}

/**
 * Builds an RMCP+ datagram. The integrity code, where one is needed, is
 * appended by the caller: it depends on the session keys.
 */
export function buildPacket(options: {
  payloadType: number;
  sessionId: number;
  sessionSequence: number;
  payload: Buffer;
  encrypted?: boolean;
  authenticated?: boolean;
}): Buffer {
  let typeByte = options.payloadType;
  if (options.encrypted) typeByte |= PAYLOAD_ENCRYPTED;
  if (options.authenticated) typeByte |= PAYLOAD_AUTHENTICATED;

  const header = Buffer.alloc(12);
  header.writeUInt8(AUTH_TYPE_RMCP_PLUS, 0);
  header.writeUInt8(typeByte, 1);
  header.writeUInt32LE(options.sessionId >>> 0, 2);
  header.writeUInt32LE(options.sessionSequence >>> 0, 6);
  header.writeUInt16LE(options.payload.length, 10);

  return Buffer.concat([buildRmcpHeader(), header, options.payload]);
}

/** Parses an incoming datagram. Returns null when it is not RMCP+ IPMI. */
export function parsePacket(datagram: Buffer): RmcpPacket | null {
  if (datagram.length < 16) return null;
  if (datagram[0] !== RMCP_VERSION || datagram[3] !== RMCP_CLASS_IPMI) return null;
  if (datagram[4] !== AUTH_TYPE_RMCP_PLUS) return null;

  const typeByte = datagram[5];
  const payloadLength = datagram.readUInt16LE(14);
  const payload = datagram.subarray(16, 16 + payloadLength);
  if (payload.length !== payloadLength) return null;

  return {
    payloadType: typeByte & 0x3f,
    encrypted: (typeByte & PAYLOAD_ENCRYPTED) !== 0,
    authenticated: (typeByte & PAYLOAD_AUTHENTICATED) !== 0,
    sessionId: datagram.readUInt32LE(6),
    sessionSequence: datagram.readUInt32LE(10),
    payload,
  };
}

/** The IPMB checksum: the two's complement of the byte sum, modulo 256. */
export function checksum(data: Buffer): number {
  let sum = 0;
  for (const byte of data) sum = (sum + byte) & 0xff;
  return (256 - sum) & 0xff;
}

/**
 * Builds an IPMI message (the body of an IPMI-type payload): the BMC address,
 * netFn/LUN, a checksum, the console address, the request number, the
 * command, its data and a trailing checksum.
 */
export function buildIpmiMessage(
  netFn: number,
  command: number,
  data: Buffer = Buffer.alloc(0),
  sequence = 0,
): Buffer {
  const head = Buffer.from([BMC_ADDRESS, (netFn << 2) & 0xfc]);
  const body = Buffer.concat([
    Buffer.from([REMOTE_CONSOLE_ADDRESS, (sequence << 2) & 0xfc, command]),
    data,
  ]);
  return Buffer.concat([
    head,
    Buffer.from([checksum(head)]),
    body,
    Buffer.from([checksum(body)]),
  ]);
}

export interface IpmiResponse {
  netFn: number;
  command: number;
  /** Completion code: 0 means success. */
  completionCode: number;
  data: Buffer;
  sequence: number;
}

export function parseIpmiMessage(payload: Buffer): IpmiResponse | null {
  // At minimum: rqAddr, netFn, csum, rsAddr, seq, cmd, completion, csum.
  if (payload.length < 8) return null;
  return {
    netFn: payload[1] >> 2,
    sequence: payload[4] >> 2,
    command: payload[5],
    completionCode: payload[6],
    data: payload.subarray(7, payload.length - 1),
  };
}

/** Completion codes that turn up in practice. */
export function describeCompletionCode(code: number): string {
  switch (code) {
    case 0x00:
      return 'success';
    case 0xc0:
      return 'node busy';
    case 0xc1:
      return 'invalid command';
    case 0xc3:
      return 'command timeout';
    case 0xc7:
      return 'invalid request length';
    case 0xc9:
      return 'parameter out of range';
    case 0xcb:
      return 'requested data not present';
    case 0xcc:
      return 'invalid data in request';
    case 0xd4:
      return 'insufficient privilege';
    case 0xd5:
      return 'command not supported in present state';
    default:
      return `code 0x${code.toString(16).padStart(2, '0')}`;
  }
}

/** RMCP+ status codes from table 13-15. */
export function describeRmcpStatus(code: number): string {
  switch (code) {
    case 0x00:
      return 'success';
    case 0x01:
      return 'insufficient resources for authentication';
    case 0x02:
      return 'invalid integrity algorithm';
    case 0x03:
      return 'no matching session';
    case 0x04:
      return 'no session slot available';
    case 0x05:
      return 'user session limit reached';
    case 0x0c:
      return 'unknown user name or wrong password';
    case 0x0d:
      return 'user access denied';
    case 0x0f:
      return 'requested privilege level not available';
    case 0x12:
      return 'invalid session id';
    default:
      return `code 0x${code.toString(16).padStart(2, '0')}`;
  }
}
