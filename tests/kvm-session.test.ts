import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KvmSession } from '../src/main/kvm/session';
import type { KvmCredentials } from '../src/shared/types';
import type { Message } from '../src/shared/i18n';

/**
 * The setup timeout, against a socket that behaves like a BMC whose video
 * engine has wedged: the connection is accepted and nothing is ever sent.
 *
 * That is not a hypothetical — a MegaRAC board in that state answers on the
 * web interface, over IPMI and on the virtual media ports, while port 7578
 * accepts a connection and says nothing at all. Before the timer the session
 * stayed in that state for as long as the application ran.
 */

let server: net.Server | null = null;
let accepted: net.Socket[] = [];

afterEach(async () => {
  const running = server;
  server = null;
  // close() alone waits for the accepted sockets, and a session that timed out
  // leaves one behind.
  for (const socket of accepted) socket.destroy();
  accepted = [];
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

/** Starts a listener that accepts connections and answers with `reply`. */
async function listen(reply?: Buffer): Promise<number> {
  const created = net.createServer((socket) => {
    accepted.push(socket);
    if (reply) socket.write(reply);
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const address = created.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function credentials(port: number): KvmCredentials {
  return {
    host: '127.0.0.1',
    webCookie: 'cookie',
    kvmToken: '0123456789abcdef',
    kvmPort: port,
    kvmSecure: false,
    cdPort: 5120,
    fdPort: 5122,
    hdPort: 5123,
    userPrivileges: 255,
  };
}

function closeReason(session: KvmSession): Promise<Message> {
  return new Promise((resolve, reject) => {
    session.once('closed', resolve);
    session.once('error', reject);
  });
}

describe('the KVM session setup timeout', () => {
  it('gives up on a silent BMC and names the reason', async () => {
    const port = await listen();
    const session = new KvmSession(credentials(port), { handshakeTimeoutMs: 150 });

    const closed = closeReason(session);
    session.connect();

    const reason = await closed;
    expect(reason.key).toBe('kvm.noGreeting');
    // The port is in the message: with several servers open it is the only
    // thing saying which one went quiet.
    expect(reason.params).toMatchObject({ port });
  });

  it('tells a stalled handshake apart from silence', async () => {
    // SESSION_ACCEPTED (23) and then nothing: the BMC started the exchange but
    // never confirmed the token.
    const greeting = Buffer.alloc(8);
    greeting.writeUInt16LE(23, 0);

    const port = await listen(greeting);
    const session = new KvmSession(credentials(port), { handshakeTimeoutMs: 150 });

    const closed = closeReason(session);
    session.connect();

    expect((await closed).key).toBe('kvm.handshakeTimeout');
  });

  it('stays quiet once the session is authenticated', async () => {
    // VALIDATE_VIDEO_SESSION_RESPONSE (19) with a non-zero body — accepted.
    const accepted = Buffer.alloc(9);
    accepted.writeUInt16LE(19, 0);
    accepted.writeInt32LE(1, 2);
    accepted.writeUInt8(1, 8);

    const port = await listen(accepted);
    const session = new KvmSession(credentials(port), { handshakeTimeoutMs: 150 });

    const authenticated = new Promise<void>((resolve) => session.once('authenticated', resolve));
    const closed = closeReason(session).then(() => 'closed');
    session.connect();
    await authenticated;

    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve('still open'), 300)),
    ]);
    expect(outcome).toBe('still open');
    session.close();
  });
});
