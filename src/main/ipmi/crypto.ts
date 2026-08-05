import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppError } from '@shared/i18n';

/**
 * RMCP+ cryptography (IPMI 2.0, section 13 of the specification).
 *
 * The one combination virtually every BMC understands is supported:
 * RAKP-HMAC-SHA1 authentication, HMAC-SHA1-96 integrity and AES-CBC-128
 * encryption.
 */

/** Algorithm identifiers from tables 13-17..13-19 of the specification. */
export const AuthAlgorithm = {
  RAKP_NONE: 0x00,
  RAKP_HMAC_SHA1: 0x01,
  RAKP_HMAC_MD5: 0x02,
  RAKP_HMAC_SHA256: 0x03,
} as const;

export const IntegrityAlgorithm = {
  NONE: 0x00,
  HMAC_SHA1_96: 0x01,
  HMAC_MD5_128: 0x02,
  MD5_128: 0x03,
  HMAC_SHA256_128: 0x04,
} as const;

export const ConfidentialityAlgorithm = {
  NONE: 0x00,
  AES_CBC_128: 0x01,
  XRC4_128: 0x02,
  XRC4_40: 0x03,
} as const;

/** Length of the HMAC-SHA1-96 integrity code in the packet trailer. */
export const INTEGRITY_CODE_LENGTH = 12;

const AES_BLOCK_SIZE = 16;

/** The user password is zero-padded to 20 bytes — that is the Kuid key. */
export function passwordKey(password: string): Buffer {
  const key = Buffer.alloc(20);
  const raw = Buffer.from(password, 'utf8');
  if (raw.length > 20) throw new AppError('error.ipmiPasswordTooLong');
  raw.copy(key);
  return key;
}

export function hmacSha1(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha1', key).update(data).digest();
}

/**
 * Session Integrity Key: HMAC(Kg, Rm || Rc || Rolem || ULen || UName).
 * When the BMC has no separate Kg configured, Kuid is used in its place.
 */
export function deriveSik(
  kg: Buffer,
  consoleRandom: Buffer,
  systemRandom: Buffer,
  privilegeByte: number,
  username: string,
): Buffer {
  const name = Buffer.from(username, 'utf8');
  const data = Buffer.concat([
    consoleRandom,
    systemRandom,
    Buffer.from([privilegeByte, name.length]),
    name,
  ]);
  return hmacSha1(kg, data);
}

/** K1 — the integrity key: HMAC(SIK, 0x01 x 20). */
export function deriveK1(sik: Buffer): Buffer {
  return hmacSha1(sik, Buffer.alloc(20, 0x01));
}

/** K2 — the confidentiality key source: HMAC(SIK, 0x02 x 20), first 16 bytes. */
export function deriveK2(sik: Buffer): Buffer {
  return hmacSha1(sik, Buffer.alloc(20, 0x02)).subarray(0, 16);
}

/** The packet integrity code — the first 12 bytes of HMAC-SHA1. */
export function integrityCode(k1: Buffer, data: Buffer): Buffer {
  return hmacSha1(k1, data).subarray(0, INTEGRITY_CODE_LENGTH);
}

/**
 * Encrypts a payload with AES-CBC-128.
 *
 * Format: a random IV (16 bytes), then the data padded the IPMI way — bytes
 * 0x01, 0x02, … with the pad length as the very last byte.
 */
export function encryptPayload(k2: Buffer, payload: Buffer): Buffer {
  const iv = randomBytes(AES_BLOCK_SIZE);
  // Padding is always present, even when the length is already a multiple of
  // the block size: the last byte must carry the pad length.
  const padLength = AES_BLOCK_SIZE - ((payload.length + 1) % AES_BLOCK_SIZE);
  const pad = Buffer.alloc(padLength);
  for (let i = 0; i < padLength; i++) pad[i] = i + 1;

  const cipher = createCipheriv('aes-128-cbc', k2, iv);
  cipher.setAutoPadding(false);
  const body = Buffer.concat([payload, pad, Buffer.from([padLength])]);
  return Buffer.concat([iv, cipher.update(body), cipher.final()]);
}

/** Decrypts a payload and strips the padding. */
export function decryptPayload(k2: Buffer, encrypted: Buffer): Buffer {
  if (encrypted.length <= AES_BLOCK_SIZE || (encrypted.length - AES_BLOCK_SIZE) % AES_BLOCK_SIZE) {
    throw new AppError('error.ipmiBadPayloadLength');
  }
  const iv = encrypted.subarray(0, AES_BLOCK_SIZE);
  const decipher = createDecipheriv('aes-128-cbc', k2, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([
    decipher.update(encrypted.subarray(AES_BLOCK_SIZE)),
    decipher.final(),
  ]);

  const padLength = plain[plain.length - 1];
  if (padLength > plain.length - 1) throw new AppError('error.ipmiBadPadding');
  return plain.subarray(0, plain.length - padLength - 1);
}

export function randomNonce(size = 16): Buffer {
  return randomBytes(size);
}
