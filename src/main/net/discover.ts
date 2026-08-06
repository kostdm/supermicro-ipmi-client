/**
 * Discovery of BMCs on the local network.
 *
 * Every address in the range is sent a Get Channel Authentication Capabilities
 * request over IPMI over LAN (UDP 623). The command works outside a session —
 * no credentials are needed — and only a BMC answers it, so a reply is proof
 * that something manageable lives at that address. This is what `ipmiping`
 * does, and it is far more selective than knocking on TCP 80.
 *
 * The datagram carries the IPMI 1.5 session header rather than RMCP+: a BMC
 * that only speaks IPMI 1.5 would ignore the newer format, and the reply tells
 * us which versions it supports anyway.
 */
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { DiscoveredServer, ScanRange } from '@shared/types';
import { AppError } from '@shared/i18n';
import {
  IPMI_PORT,
  NetFn,
  RMCP_CLASS_IPMI,
  RMCP_VERSION,
  buildIpmiMessage,
  parseIpmiMessage,
} from '../ipmi/protocol';

/** Get Channel Authentication Capabilities. */
const CMD_GET_CHANNEL_AUTH_CAPABILITIES = 0x38;

/** The channel the request arrives on, whichever that turns out to be. */
const CHANNEL_CURRENT = 0x0e;
/** Bit 7 asks a BMC that speaks IPMI 2.0 to report its extended capabilities. */
const REQUEST_IPMI_20 = 0x80;

const PRIVILEGE_ADMINISTRATOR = 0x04;

/** Session header of an unauthenticated IPMI 1.5 datagram. */
const AUTH_TYPE_NONE = 0x00;

/**
 * A scan is a burst of datagrams, and a BMC that is busy answering another
 * client drops them. Two passes cost little and pick up most of what a single
 * pass loses.
 */
const PASSES = 2;

/** Datagrams sent before yielding, and the pause taken afterwards. */
const BURST_SIZE = 64;
const BURST_PAUSE_MS = 10;

/** How long replies are still collected after the last datagram goes out. */
const REPLY_WINDOW_MS = 1500;

/**
 * Upper bound on the size of a range.
 *
 * A /19 already takes minutes and floods the link; anything wider is a typo in
 * the form rather than an intention.
 */
export const MAX_SCAN_ADDRESSES = 8192;

/** IANA enterprise numbers seen in the OEM field of a BMC reply. */
const VENDORS: Record<number, string> = {
  11: 'HPE',
  343: 'Intel',
  674: 'Dell',
  2011: 'Huawei',
  4753: 'AMI',
  5771: 'Cisco',
  10876: 'Supermicro',
  20301: 'Lenovo',
};

export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    // Number('') is 0 and Number('1e2') is 100 — neither is an octet.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

export function intToIp(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}

/**
 * The range covering the network this machine sits on.
 *
 * The network and broadcast addresses are trimmed off, so a /24 comes back as
 * .1 through .254. Returns null when there is no external IPv4 interface —
 * on a machine with nothing but a loopback there is nothing to offer.
 */
export function localScanRange(): ScanRange | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;

      const ip = ipToInt(address.address);
      const mask = ipToInt(address.netmask);
      if (ip === null || mask === null) continue;

      const network = (ip & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;
      // A /31 or /32 leaves no usable hosts to trim down to.
      if (broadcast - network < 2) continue;

      return { from: intToIp(network + 1), to: intToIp(broadcast - 1) };
    }
  }
  return null;
}

/** The discovery datagram: an IPMI 1.5 session header with no authentication. */
export function buildDiscoveryRequest(): Buffer {
  const message = buildIpmiMessage(
    NetFn.APP,
    CMD_GET_CHANNEL_AUTH_CAPABILITIES,
    Buffer.from([CHANNEL_CURRENT | REQUEST_IPMI_20, PRIVILEGE_ADMINISTRATOR]),
  );

  const header = Buffer.alloc(14);
  header.writeUInt8(RMCP_VERSION, 0);
  header.writeUInt8(0x00, 1);
  // Packets outside a session carry no sequence number to acknowledge.
  header.writeUInt8(0xff, 2);
  header.writeUInt8(RMCP_CLASS_IPMI, 3);
  header.writeUInt8(AUTH_TYPE_NONE, 4);
  // Session sequence and session id are zero outside a session.
  header.writeUInt8(message.length, 13);

  return Buffer.concat([header, message]);
}

export interface DiscoveryReply {
  /** The highest version the BMC reports support for. */
  ipmiVersion: '1.5' | '2.0';
  /** IANA enterprise number, 0 when the BMC does not report one. */
  oemId: number;
  vendor: string | null;
}

/** Parses a reply. Returns null for anything that is not a BMC answering us. */
export function parseDiscoveryReply(datagram: Buffer): DiscoveryReply | null {
  // RMCP header, session header, message length, and a message of its own.
  if (datagram.length < 22) return null;
  if (datagram[0] !== RMCP_VERSION || datagram[3] !== RMCP_CLASS_IPMI) return null;
  // The reply to an unauthenticated request carries no authentication code.
  if (datagram[4] !== AUTH_TYPE_NONE) return null;

  const messageLength = datagram[13];
  const message = datagram.subarray(14, 14 + messageLength);
  if (message.length !== messageLength) return null;

  const response = parseIpmiMessage(message);
  if (!response) return null;
  if (response.command !== CMD_GET_CHANNEL_AUTH_CAPABILITIES) return null;
  if (response.completionCode !== 0) return null;

  // channel, auth support, auth status, extended capabilities, OEM id, OEM aux.
  const data = response.data;
  if (data.length < 8) return null;

  const supportsIpmi20 = (data[3] & 0x02) !== 0;
  const oemId = data[4] | (data[5] << 8) | (data[6] << 16);

  return {
    ipmiVersion: supportsIpmi20 ? '2.0' : '1.5',
    oemId,
    vendor: VENDORS[oemId] ?? null,
  };
}

export interface ScanCallbacks {
  /** Called once per address that answers, as the reply arrives. */
  onFound(server: DiscoveredServer): void;
  /** Progress of the current pass, in addresses. */
  onProgress(scanned: number, total: number): void;
}

/**
 * Sweeps a range of addresses.
 *
 * Datagrams go out from a single socket without waiting for replies: a scan
 * of a /24 is dominated by the reply window, not by the number of hosts.
 */
export class NetworkScanner {
  private socket: Socket | null = null;
  private cancelled = false;
  private readonly found = new Map<string, DiscoveredServer>();

  async scan(range: ScanRange, callbacks: ScanCallbacks): Promise<DiscoveredServer[]> {
    const first = ipToInt(range.from);
    const last = ipToInt(range.to);
    if (first === null || last === null) throw new AppError('scan.badRange');
    if (last < first) throw new AppError('scan.reversedRange');

    const total = last - first + 1;
    if (total > MAX_SCAN_ADDRESSES) {
      throw new AppError('scan.rangeTooWide', { max: MAX_SCAN_ADDRESSES });
    }

    const socket = createSocket('udp4');
    this.socket = socket;
    this.cancelled = false;
    this.found.clear();

    socket.on('message', (datagram, remote) => {
      if (this.found.has(remote.address)) return;
      const reply = parseDiscoveryReply(datagram);
      if (!reply) return;

      const server: DiscoveredServer = { host: remote.address, ...reply };
      this.found.set(remote.address, server);
      callbacks.onFound(server);
    });

    // A single socket error (an unreachable network, say) must not take the
    // whole scan down: individual sends can fail for one interface only.
    socket.on('error', () => {});

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(resolve);
      });

      const request = buildDiscoveryRequest();

      for (let pass = 0; pass < PASSES && !this.cancelled; pass++) {
        for (let address = first; address <= last && !this.cancelled; address++) {
          try {
            socket.send(request, IPMI_PORT, intToIp(address), () => {
              // Failures are expected: no route to host, blocked broadcast,
              // ICMP unreachable. Silence is the same as no BMC being there.
            });
          } catch {
            // cancel() can close the socket between the check and the send.
            break;
          }

          // Progress counts every pass, so the bar only ever moves forward.
          const scanned = pass * total + (address - first + 1);
          if (scanned % BURST_SIZE === 0) {
            callbacks.onProgress(scanned, total * PASSES);
            await delay(BURST_PAUSE_MS);
          }
        }
        callbacks.onProgress((pass + 1) * total, total * PASSES);
      }

      if (!this.cancelled) await delay(REPLY_WINDOW_MS);
    } finally {
      this.close();
    }

    return [...this.found.values()];
  }

  cancel(): void {
    this.cancelled = true;
    this.close();
  }

  private close(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    try {
      socket.close();
    } catch {
      // Already closed — cancel and the end of a scan can race.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
