/**
 * The IVTP protocol — the transport of an AMI KVM session (port 7578).
 *
 * A packet header is 8 bytes, little-endian, unaligned:
 *   off 0  u16  type
 *   off 2  i32  pktSize   (body length after the header)
 *   off 6  u16  status
 *
 * The layout and the constants come from the decompiled JViewer, class
 * IVTPPktHdr.
 */

export const IVTP_HEADER_SIZE = 8;

/** Packet types. The same codes travel in both directions. */
export const Pkt = {
  HID: 1,
  SET_BANDWIDTH: 2,
  SET_FPS: 3,
  PAUSE_REDIRECTION: 4,
  REFRESH_VIDEO_SCREEN: 5,
  RESUME_REDIRECTION: 6,
  SET_COMPRESSION_TYPE: 7,
  STOP_SESSION_IMMEDIATE: 8,
  BLANK_SCREEN: 9,
  GET_USB_MOUSE_MODE: 10,
  GET_FULL_SCREEN: 11,
  ENABLE_ENCRYPTION: 12,
  DISABLE_ENCRYPTION: 13,
  ENCRYPTION_STATUS: 14,
  INITIAL_ENCRYPTION_STATUS: 15,
  BW_DETECT_REQ: 16,
  BW_DETECT_RESP: 17,
  VALIDATE_VIDEO_SESSION: 18,
  VALIDATE_VIDEO_SESSION_RESPONSE: 19,
  GET_KEYBD_LED: 20,
  GET_WEB_TOKEN: 21,
  MAX_SESSION_CLOSING: 22,
  SESSION_ACCEPTED: 23,
  MEDIA_STATE: 24,
  VIDEO_FRAGMENT: 25,
  WEB_PREVIEWER_SESSION: 26,
  WEB_PREVIEWER_CAPTURE_STATUS: 27,
  SET_MOUSE_MODE: 28,
  KVM_SHARING: 32,
  KVM_SOCKET_STATUS: 33,
  POWER_STATUS: 34,
  POWER_CONTROL_REQUEST: 35,
  POWER_CONTROL_RESPONSE: 36,
  CONF_SERVICE_STATUS: 37,
  MOUSE_MEDIA_INFO: 38,
  GET_ACTIVE_CLIENTS: 39,
  CLEAR_VIDEO_BUFFER: 40,
} as const;

export type PktType = (typeof Pkt)[keyof typeof Pkt];

/** Power command codes — sent in the status field of POWER_CONTROL_REQUEST. */
export const PowerControl = {
  OFF_IMMEDIATE: 0,
  ON: 1,
  CYCLE: 2,
  HARD_RESET: 3,
  SOFT_RESET: 4,
} as const;

/** Mouse modes — received in GET_USB_MOUSE_MODE, sent in SET_MOUSE_MODE. */
export const MouseModeCode = {
  RELATIVE: 1,
  ABSOLUTE: 2,
  OTHER: 3,
} as const;

/** Session close reasons — the status field of STOP_SESSION_IMMEDIATE. */
export const StopReason = {
  ENGINE_CLOSING: 2,
  INVALID_VIDEO_TOKEN: 3,
  CONF_CHANGED: 5,
  WEB_LOGOUT: 7,
} as const;

/** On-the-wire body length of the VALIDATE_VIDEO_SESSION packet. */
export const VALIDATE_BODY_SIZE = 324;

/**
 * The value JViewer puts into the pktSize field of VALIDATE_VIDEO_SESSION.
 *
 * It does not match the actual body length (324 bytes): the BMC reads a
 * fixed-size structure and ignores pktSize here. The discrepancy is
 * reproduced verbatim — "fixing" it breaks authentication.
 * See JViewerApp.java in the decompiled sources.
 */
export const VALIDATE_DECLARED_SIZE = 140;

/** Offset of the client's local IP string inside the VALIDATE_VIDEO_SESSION body. */
export const VALIDATE_CLIENT_IP_OFFSET = 99;

/** Offset of the session token inside the same body. */
export const VALIDATE_TOKEN_OFFSET = 1;

export interface IvtpHeader {
  type: number;
  pktSize: number;
  status: number;
}

/** Builds the 8-byte header. */
export function buildHeader(type: number, pktSize = 0, status = 0): Buffer {
  const buf = Buffer.allocUnsafe(IVTP_HEADER_SIZE);
  buf.writeUInt16LE(type, 0);
  buf.writeInt32LE(pktSize, 2);
  buf.writeUInt16LE(status, 6);
  return buf;
}

export function readHeader(buf: Buffer, offset = 0): IvtpHeader {
  return {
    type: buf.readUInt16LE(offset),
    pktSize: buf.readInt32LE(offset + 2),
    status: buf.readUInt16LE(offset + 6),
  };
}

/** A packet with no body — most control commands look like this. */
export function buildControl(type: number, status = 0): Buffer {
  return buildHeader(type, 0, status);
}

/** GET_WEB_TOKEN: header + the web session cookie in ASCII, unterminated. */
export function buildWebTokenPacket(webCookie: string): Buffer {
  const body = Buffer.from(webCookie, 'ascii');
  return Buffer.concat([buildHeader(Pkt.GET_WEB_TOKEN, body.length, 0), body]);
}

/**
 * VALIDATE_VIDEO_SESSION: header + a 324-byte body.
 *
 * Body: [0] = 0, [1..16] the token, zeroes up to [99], then the client's
 * local IP in ASCII, the rest zeroed.
 */
export function buildValidatePacket(kvmToken: string, clientIp: string): Buffer {
  const packet = Buffer.alloc(IVTP_HEADER_SIZE + VALIDATE_BODY_SIZE);
  buildHeader(Pkt.VALIDATE_VIDEO_SESSION, VALIDATE_DECLARED_SIZE, 0).copy(packet, 0);
  packet.write(kvmToken, IVTP_HEADER_SIZE + VALIDATE_TOKEN_OFFSET, 'ascii');
  packet.write(clientIp, IVTP_HEADER_SIZE + VALIDATE_CLIENT_IP_OFFSET, 'ascii');
  return packet;
}

/** Bandwidth values for SET_BANDWIDTH (bytes per second). */
export const Bandwidth = {
  MBPS_100: 0xc80000,
  MBPS_10: 0x140000,
  MBPS_1: 131072,
  KBPS_512: 65536,
  KBPS_256: 32768,
} as const;

/** SET_BANDWIDTH: header + i32 LE. */
export function buildBandwidthPacket(bytesPerSecond: number): Buffer {
  const body = Buffer.allocUnsafe(4);
  body.writeInt32LE(bytesPerSecond, 0);
  return Buffer.concat([buildHeader(Pkt.SET_BANDWIDTH, 4, 0), body]);
}
