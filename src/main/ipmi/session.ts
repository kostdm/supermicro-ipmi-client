import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import {
  AuthAlgorithm,
  ConfidentialityAlgorithm,
  INTEGRITY_CODE_LENGTH,
  IntegrityAlgorithm,
  decryptPayload,
  deriveK1,
  deriveK2,
  deriveSik,
  encryptPayload,
  hmacSha1,
  integrityCode,
  passwordKey,
  randomNonce,
} from './crypto';
import {
  IPMI_PORT,
  PayloadType,
  PrivilegeLevel,
  buildIpmiMessage,
  buildPacket,
  describeCompletionCode,
  describeRmcpStatus,
  parseIpmiMessage,
  parsePacket,
  type IpmiResponse,
} from './protocol';

/**
 * An IPMI 2.0 over LAN session (RMCP+).
 *
 * Setup order: Open Session Request/Response, then RAKP 1..4. After that
 * packets are encrypted with AES-CBC-128 and signed with HMAC-SHA1-96.
 *
 * IpmiError messages stay in English: they describe protocol conditions and
 * are meant for logs and bug reports rather than for the interface.
 */

export interface IpmiSessionOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  privilege?: number;
  timeoutMs?: number;
  retries?: number;
}

export class IpmiError extends Error {
  constructor(
    message: string,
    readonly completionCode?: number,
  ) {
    super(message);
    this.name = 'IpmiError';
  }
}

/** The name-only-lookup bit in the RAKP1 privilege byte. */
const NAME_ONLY_LOOKUP = 0x10;

export class IpmiSession {
  private socket: dgram.Socket | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly privilege: number;
  private readonly timeoutMs: number;
  private readonly retries: number;

  /** The session id assigned by the BMC. */
  private systemSessionId = 0;
  private consoleSessionId = 0;
  private sequence = 0;
  private k1: Buffer = Buffer.alloc(0);
  private k2: Buffer = Buffer.alloc(0);
  private established = false;

  /** IPMI request number, wrapping around within 6 bits. */
  private requestSequence = 0;

  /** Response handler for the request in flight. */
  private pending: ((packet: Buffer) => void) | null = null;

  /**
   * Tail of the request queue.
   *
   * A session can only have one request outstanding: sequence numbers
   * increment and the socket is shared, so concurrent calls would mix up the
   * replies. The queue lines them up one after another.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: IpmiSessionOptions) {
    this.host = options.host;
    this.port = options.port ?? IPMI_PORT;
    this.username = options.username;
    this.password = options.password;
    this.privilege = options.privilege ?? PrivilegeLevel.ADMINISTRATOR;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.retries = options.retries ?? 2;
  }

  get isEstablished(): boolean {
    return this.established;
  }

  async connect(): Promise<void> {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg) => {
      const handler = this.pending;
      if (handler) {
        this.pending = null;
        handler(msg);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.socket!.once('error', reject);
      this.socket!.bind(() => resolve());
    });

    // The console id is arbitrary and only serves to tag the replies.
    this.consoleSessionId = randomInt(1, 0xffffffff);

    const openResponse = await this.openSession();
    this.systemSessionId = openResponse.systemSessionId;

    await this.performRakp();
    this.established = true;
  }

  close(): void {
    this.established = false;
    this.socket?.close();
    this.socket = null;
  }

  /** Sends an IPMI command and returns the response data. */
  async command(netFn: number, cmd: number, data: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    const response = await this.tryCommand(netFn, cmd, data);
    if (response.completionCode !== 0) {
      throw new IpmiError(
        `Command 0x${cmd.toString(16)} failed: ` +
          describeCompletionCode(response.completionCode),
        response.completionCode,
      );
    }
    return response.data;
  }

  /** The full response, non-zero completion code included — for soft commands. */
  async tryCommand(
    netFn: number,
    cmd: number,
    data: Buffer = Buffer.alloc(0),
  ): Promise<IpmiResponse> {
    if (!this.established) throw new IpmiError('the IPMI session is not established');

    return this.enqueue(async () => {
      const sequence = this.requestSequence;
      this.requestSequence = (this.requestSequence + 1) & 0x3f;

      const message = buildIpmiMessage(netFn, cmd, data, sequence);
      const reply = await this.sendSessionPacket(PayloadType.IPMI, message);
      const response = parseIpmiMessage(reply);
      if (!response) throw new IpmiError('could not parse the IPMI response');
      return response;
    });
  }

  /** Queues an operation so requests never overlap on the one socket. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // A failed request must not break the chain for the ones behind it.
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // --- session setup ---

  private async openSession(): Promise<{ systemSessionId: number }> {
    const payload = Buffer.alloc(32);
    payload.writeUInt8(0, 0); // message tag
    payload.writeUInt8(this.privilege, 1);
    payload.writeUInt32LE(this.consoleSessionId, 4);

    // Three algorithm negotiation blocks: authentication, integrity, confidentiality.
    payload.writeUInt8(0x00, 8); // type: authentication
    payload.writeUInt8(8, 11); // block length
    payload.writeUInt8(AuthAlgorithm.RAKP_HMAC_SHA1, 12);

    payload.writeUInt8(0x01, 16); // type: integrity
    payload.writeUInt8(8, 19);
    payload.writeUInt8(IntegrityAlgorithm.HMAC_SHA1_96, 20);

    payload.writeUInt8(0x02, 24); // type: confidentiality
    payload.writeUInt8(8, 27);
    payload.writeUInt8(ConfidentialityAlgorithm.AES_CBC_128, 28);

    const response = await this.sendPreSession(PayloadType.OPEN_SESSION_REQUEST, payload);
    if (response.length < 16) {
      throw new IpmiError('the open session response is too short');
    }

    const status = response[1];
    if (status !== 0) {
      throw new IpmiError(`the BMC refused to open a session: ${describeRmcpStatus(status)}`);
    }
    return { systemSessionId: response.readUInt32LE(8) };
  }

  private async performRakp(): Promise<void> {
    const consoleRandom = randomNonce(16);
    const kuid = passwordKey(this.password);
    const nameBuffer = Buffer.from(this.username, 'utf8');
    if (nameBuffer.length > 16) {
      throw new IpmiError('an IPMI user name cannot exceed 16 bytes');
    }
    const privilegeByte = this.privilege | NAME_ONLY_LOOKUP;

    // RAKP 1: send our own random nonce and the user name.
    const rakp1 = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      uint32le(this.systemSessionId),
      consoleRandom,
      Buffer.from([privilegeByte, 0, 0, nameBuffer.length]),
      nameBuffer,
    ]);
    const rakp2 = await this.sendPreSession(PayloadType.RAKP_1, rakp1);

    if (rakp2.length < 8) throw new IpmiError('the RAKP2 response is too short');
    const status = rakp2[1];
    if (status !== 0) {
      throw new IpmiError(`IPMI authentication failed: ${describeRmcpStatus(status)}`);
    }
    if (rakp2.length < 40) throw new IpmiError('the RAKP2 response carries no auth code');

    const systemRandom = rakp2.subarray(8, 24);
    const systemGuid = rakp2.subarray(24, 40);
    const systemAuthCode = rakp2.subarray(40);

    // Verify that the BMC knows the password: otherwise someone could be
    // sitting in the middle. Field order: SIDm (console), SIDc (BMC), nonces.
    const expected = hmacSha1(
      kuid,
      Buffer.concat([
        uint32le(this.consoleSessionId),
        uint32le(this.systemSessionId),
        consoleRandom,
        systemRandom,
        systemGuid,
        Buffer.from([privilegeByte, nameBuffer.length]),
        nameBuffer,
      ]),
    );
    if (systemAuthCode.length > 0 && !expected.equals(systemAuthCode)) {
      throw new IpmiError('the BMC did not confirm the password: the RAKP2 auth code differs');
    }

    // The session keys are derived from both nonces.
    const sik = deriveSik(kuid, consoleRandom, systemRandom, privilegeByte, this.username);
    this.k1 = deriveK1(sik);
    this.k2 = deriveK2(sik);

    // RAKP 3: prove that we know the password too.
    const consoleAuthCode = hmacSha1(
      kuid,
      Buffer.concat([
        systemRandom,
        uint32le(this.consoleSessionId),
        Buffer.from([privilegeByte, nameBuffer.length]),
        nameBuffer,
      ]),
    );
    const rakp3 = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      uint32le(this.systemSessionId),
      consoleAuthCode,
    ]);
    const rakp4 = await this.sendPreSession(PayloadType.RAKP_3, rakp3);

    if (rakp4.length < 8) throw new IpmiError('the RAKP4 response is too short');
    if (rakp4[1] !== 0) {
      throw new IpmiError(`the BMC rejected RAKP3: ${describeRmcpStatus(rakp4[1])}`);
    }

    const integrityValue = rakp4.subarray(8);
    if (integrityValue.length > 0) {
      const expectedIntegrity = hmacSha1(
        sik,
        Buffer.concat([consoleRandom, uint32le(this.systemSessionId), systemGuid]),
      ).subarray(0, INTEGRITY_CODE_LENGTH);
      if (!expectedIntegrity.equals(integrityValue.subarray(0, INTEGRITY_CODE_LENGTH))) {
        throw new IpmiError('the RAKP4 integrity check failed');
      }
    }
  }

  // --- transport ---

  /** Setup-stage packets travel unencrypted and unsigned. */
  private async sendPreSession(payloadType: number, payload: Buffer): Promise<Buffer> {
    const packet = buildPacket({
      payloadType,
      sessionId: 0,
      sessionSequence: 0,
      payload,
    });
    const reply = await this.transact(packet);
    const parsed = parsePacket(reply);
    if (!parsed) throw new IpmiError('received a malformed RMCP+ packet');
    return parsed.payload;
  }

  /** Packets of an established session are encrypted and signed. */
  private async sendSessionPacket(payloadType: number, message: Buffer): Promise<Buffer> {
    this.sequence++;

    const encrypted = encryptPayload(this.k2, message);
    const base = buildPacket({
      payloadType,
      sessionId: this.systemSessionId,
      sessionSequence: this.sequence,
      payload: encrypted,
      encrypted: true,
      authenticated: true,
    });

    // Integrity trailer: padding to a multiple of 4, the pad length, the next
    // header number (0x07) and the code itself.
    const authStart = 4; // the code covers everything from the auth type byte
    const padLength = (4 - ((base.length - authStart + 2) % 4)) % 4;
    const pad = Buffer.alloc(padLength, 0xff);
    const withPad = Buffer.concat([base, pad, Buffer.from([padLength, 0x07])]);
    const code = integrityCode(this.k1, withPad.subarray(authStart));
    const packet = Buffer.concat([withPad, code]);

    const reply = await this.transact(packet);
    const parsed = parsePacket(reply);
    if (!parsed) throw new IpmiError('received a malformed RMCP+ packet');

    if (!parsed.encrypted) return parsed.payload;
    return decryptPayload(this.k2, parsed.payload);
  }

  /** Sends a datagram and waits for the reply, retrying on timeout. */
  private async transact(packet: Buffer): Promise<Buffer> {
    const socket = this.socket;
    if (!socket) throw new IpmiError('the IPMI socket is closed');

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending = null;
            reject(new IpmiError(`the BMC did not answer within ${this.timeoutMs} ms`));
          }, this.timeoutMs);

          this.pending = (msg) => {
            clearTimeout(timer);
            resolve(msg);
          };

          socket.send(packet, this.port, this.host, (err) => {
            if (err) {
              clearTimeout(timer);
              this.pending = null;
              reject(err);
            }
          });
        });
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new IpmiError('the IPMI request could not be completed');
  }
}

function uint32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}
