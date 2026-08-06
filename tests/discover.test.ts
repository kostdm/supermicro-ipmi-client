import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryRequest,
  intToIp,
  ipToInt,
  parseDiscoveryReply,
} from '../src/main/net/discover';
import { checksum } from '../src/main/ipmi/protocol';

/**
 * Builds a Get Channel Authentication Capabilities reply the way a BMC sends
 * it: RMCP header, an unauthenticated IPMI 1.5 session header, and the message
 * with the response data.
 */
function buildReply(data: number[], options: { authType?: number; completionCode?: number } = {}) {
  const body = Buffer.from([0x20, 0x00, 0x38, options.completionCode ?? 0x00, ...data]);
  const head = Buffer.from([0x81, 0x1c]);
  const message = Buffer.concat([
    head,
    Buffer.from([checksum(head)]),
    body,
    Buffer.from([checksum(body)]),
  ]);

  const header = Buffer.alloc(14);
  header.writeUInt8(0x06, 0);
  header.writeUInt8(0xff, 2);
  header.writeUInt8(0x07, 3);
  header.writeUInt8(options.authType ?? 0x00, 4);
  header.writeUInt8(message.length, 13);

  return Buffer.concat([header, message]);
}

/** channel, auth support, auth status, extended caps, OEM id (LE), OEM aux. */
const SUPERMICRO_20 = [0x01, 0x95, 0x0a, 0x02, 0x7c, 0x2a, 0x00, 0x00];

describe('IPv4 arithmetic', () => {
  it('round-trips an address', () => {
    for (const ip of ['0.0.0.0', '10.0.0.5', '192.168.1.254', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip)!)).toBe(ip);
    }
  });

  it('orders addresses', () => {
    expect(ipToInt('10.0.0.2')! - ipToInt('10.0.0.1')!).toBe(1);
    expect(ipToInt('10.0.1.0')! - ipToInt('10.0.0.255')!).toBe(1);
  });

  it('rejects anything that is not four octets', () => {
    // Number() would accept every one of these; the octets are parsed by hand
    // precisely to keep them out of a scan range.
    for (const bad of ['', '10.0.0', '10.0.0.256', '10.0.0.-1', '10.0.0.1e2', '10.0.0.0.1', 'x']) {
      expect(ipToInt(bad)).toBeNull();
    }
  });
});

describe('discovery request', () => {
  const request = buildDiscoveryRequest();

  it('is an RMCP datagram of the IPMI class', () => {
    expect([...request.subarray(0, 4)]).toEqual([0x06, 0x00, 0xff, 0x07]);
  });

  it('carries an unauthenticated IPMI 1.5 session header', () => {
    expect(request[4]).toBe(0x00);
    // Session sequence and session id are zero outside a session.
    expect([...request.subarray(5, 13)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(request[13]).toBe(request.length - 14);
  });

  it('asks the current channel for IPMI 2.0 capabilities at admin privilege', () => {
    const message = request.subarray(14);
    // rsAddr, netFn App request, checksum, rqAddr, seq, command, data…
    expect(message[1] >> 2).toBe(0x06);
    expect(message[5]).toBe(0x38);
    expect(message[6]).toBe(0x8e);
    expect(message[7]).toBe(0x04);
  });

  it('has valid IPMB checksums', () => {
    const message = request.subarray(14);
    expect(checksum(message.subarray(0, 2))).toBe(message[2]);
    expect(checksum(message.subarray(3, message.length - 1))).toBe(message[message.length - 1]);
  });
});

describe('discovery reply', () => {
  it('reads the version and recognises the vendor', () => {
    expect(parseDiscoveryReply(buildReply(SUPERMICRO_20))).toEqual({
      ipmiVersion: '2.0',
      oemId: 10876,
      vendor: 'Supermicro',
    });
  });

  it('reports 1.5 when the extended capability bit is clear', () => {
    const reply = parseDiscoveryReply(buildReply([0x01, 0x15, 0x00, 0x00, 0, 0, 0, 0]));
    expect(reply?.ipmiVersion).toBe('1.5');
    expect(reply?.vendor).toBeNull();
  });

  it('rejects a non-zero completion code', () => {
    expect(parseDiscoveryReply(buildReply(SUPERMICRO_20, { completionCode: 0xc1 }))).toBeNull();
  });

  it('rejects an authenticated reply', () => {
    // Anything but auth type none carries 16 extra bytes before the message,
    // so the offsets below would be read from the wrong place.
    expect(parseDiscoveryReply(buildReply(SUPERMICRO_20, { authType: 0x02 }))).toBeNull();
  });

  it('rejects datagrams that are not RMCP IPMI', () => {
    const foreign = buildReply(SUPERMICRO_20);
    foreign.writeUInt8(0x06, 3); // ASF class rather than IPMI
    expect(parseDiscoveryReply(foreign)).toBeNull();

    expect(parseDiscoveryReply(Buffer.alloc(0))).toBeNull();
    expect(parseDiscoveryReply(Buffer.alloc(40))).toBeNull();
  });

  it('rejects a reply whose data is cut short', () => {
    expect(parseDiscoveryReply(buildReply([0x01, 0x95, 0x0a]))).toBeNull();
  });
});
