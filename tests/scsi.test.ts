import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { CD_SECTOR_SIZE, IsoScsiTarget, ScsiStatus, SenseKey } from '../src/main/vm/scsi';
import {
  IUSB_HEADER_SIZE,
  IUSB_SCSI_STRUCT_SIZE,
  IusbOpcode,
  buildAuthPacket,
  buildScsiResponse,
  parseAuthAck,
  parseIusbPacket,
} from '../src/main/vm/iusb';

/** A small image: 8 sectors, each filled with its own byte. */
const SECTORS = 8;
let dir: string;
let isoPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ipmi-iso-'));
  isoPath = join(dir, 'test.iso');
  const image = Buffer.alloc(SECTORS * CD_SECTOR_SIZE);
  for (let sector = 0; sector < SECTORS; sector++) {
    image.fill(sector + 1, sector * CD_SECTOR_SIZE, (sector + 1) * CD_SECTOR_SIZE);
  }
  writeFileSync(isoPath, image);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function open(): IsoScsiTarget {
  const target = new IsoScsiTarget(isoPath);
  target.open();
  return target;
}

describe('IsoScsiTarget', () => {
  it('answers the first command without UNIT ATTENTION', () => {
    // The BMC probes the device right after authentication and, on receiving
    // CHECK CONDITION, decides the drive is not ready and stops probing.
    const target = new IsoScsiTarget(isoPath);
    target.open();
    expect(target.execute(Buffer.from([0x00])).status).toBe(ScsiStatus.GOOD);
  });

  it('reports a medium change after the image is swapped', () => {
    const target = open();
    target.replaceMedium();

    const result = target.execute(Buffer.from([0x00]));
    expect(result.status).toBe(ScsiStatus.CHECK_CONDITION);
    expect(result.sense?.key).toBe(SenseKey.UNIT_ATTENTION);
    // The flag is reported once; commands run normally afterwards.
    expect(target.execute(Buffer.from([0x00])).status).toBe(ScsiStatus.GOOD);
  });

  it('answers TEST UNIT READY', () => {
    expect(open().execute(Buffer.from([0x00])).status).toBe(ScsiStatus.GOOD);
  });

  it('identifies as a CD-ROM drive in INQUIRY', () => {
    const cdb = Buffer.alloc(6);
    cdb[0] = 0x12;
    cdb.writeUInt16BE(36, 3);
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    expect(result.data.length).toBe(36);
    expect(result.data[0]).toBe(0x05); // device type: CD/DVD
    expect(result.data[1] & 0x80).toBe(0x80); // removable medium
    expect(result.data.subarray(8, 16).toString('ascii')).toBe('AMI     ');
    expect(result.data.subarray(16, 32).toString('ascii').trim()).toBe('Virtual CDROM');
  });

  it('returns the address of the last block in READ CAPACITY', () => {
    const cdb = Buffer.alloc(10);
    cdb[0] = 0x25;
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    // What comes back is the last block number, not the count.
    expect(result.data.readUInt32BE(0)).toBe(SECTORS - 1);
    expect(result.data.readUInt32BE(4)).toBe(CD_SECTOR_SIZE);
  });

  it('reads sectors with READ(10)', () => {
    const cdb = Buffer.alloc(10);
    cdb[0] = 0x28;
    cdb.writeUInt32BE(2, 2); // LBA = 2
    cdb.writeUInt16BE(3, 7); // three sectors
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    expect(result.data.length).toBe(3 * CD_SECTOR_SIZE);
    // Every sector of the image is filled with its own number, starting at 1.
    expect(result.data[0]).toBe(3);
    expect(result.data[CD_SECTOR_SIZE]).toBe(4);
    expect(result.data[2 * CD_SECTOR_SIZE]).toBe(5);
  });

  it('reads sectors with READ(12)', () => {
    const cdb = Buffer.alloc(12);
    cdb[0] = 0xa8;
    cdb.writeUInt32BE(0, 2);
    cdb.writeUInt32BE(1, 6);
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    expect(result.data.length).toBe(CD_SECTOR_SIZE);
    expect(result.data[0]).toBe(1);
  });

  it('refuses a read past the end of the image', () => {
    const cdb = Buffer.alloc(10);
    cdb[0] = 0x28;
    cdb.writeUInt32BE(SECTORS, 2); // past the last sector
    cdb.writeUInt16BE(1, 7);
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.CHECK_CONDITION);
    expect(result.sense?.key).toBe(SenseKey.ILLEGAL_REQUEST);
    expect(result.sense?.asc).toBe(0x21); // LBA out of range
  });

  it('returns a table of contents with a single data track', () => {
    const cdb = Buffer.alloc(10);
    cdb[0] = 0x43;
    cdb.writeUInt16BE(20, 7);
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    expect(result.data[2]).toBe(1); // first track
    expect(result.data[3]).toBe(1); // last track
    expect(result.data[6]).toBe(1); // track number
    expect(result.data[14]).toBe(0xaa); // the lead-out entry
    expect(result.data.readUInt32BE(16)).toBe(SECTORS);
  });

  it('claims the CD-ROM profile in GET CONFIGURATION', () => {
    const cdb = Buffer.alloc(10);
    cdb[0] = 0x46;
    cdb.writeUInt16BE(40, 7);
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    expect(result.data.readUInt16BE(6)).toBe(0x0008); // current profile
  });

  it('reports write protection in MODE SENSE(6)', () => {
    const cdb = Buffer.alloc(6);
    cdb[0] = 0x1a;
    cdb[2] = 0x3f; // all pages
    cdb[4] = 64;
    const result = open().execute(cdb);

    expect(result.status).toBe(ScsiStatus.GOOD);
    expect(result.data[2] & 0x80).toBe(0x80); // the medium is read-only
  });

  it('returns the stored sense data on REQUEST SENSE', () => {
    const target = open();
    const badRead = Buffer.alloc(10);
    badRead[0] = 0x28;
    badRead.writeUInt32BE(999, 2);
    badRead.writeUInt16BE(1, 7);
    target.execute(badRead);

    const cdb = Buffer.alloc(6);
    cdb[0] = 0x03;
    cdb[4] = 18;
    const result = target.execute(cdb);

    expect(result.data[0]).toBe(0x70); // current error
    expect(result.data[2] & 0x0f).toBe(SenseKey.ILLEGAL_REQUEST);
    expect(result.data[12]).toBe(0x21);
  });

  it('refuses a write as write-protected rather than as unknown', () => {
    const result = open().execute(Buffer.from([0x2a, 0, 0, 0, 0, 0, 0, 0, 1, 0]));
    expect(result.status).toBe(ScsiStatus.CHECK_CONDITION);
    expect(result.sense?.key).toBe(0x07); // data protect
    expect(result.sense?.asc).toBe(0x27); // write protected
  });

  it('rejects an unknown command', () => {
    const result = open().execute(Buffer.from([0xff]));
    expect(result.status).toBe(ScsiStatus.CHECK_CONDITION);
    expect(result.sense?.key).toBe(SenseKey.ILLEGAL_REQUEST);
    expect(result.sense?.asc).toBe(0x20); // invalid command
  });
});

/** Where the authentication reply keeps its status, regardless of the SCSI struct. */
const AUTH_STATUS_OFFSET = 30;

describe('IUSB framing', () => {
  it('builds a 160-byte authentication packet', () => {
    const packet = buildAuthPacket('6CxpkhH5pw1lRvEv');

    expect(packet.length).toBe(160);
    expect(packet.subarray(0, 8).toString('ascii')).toBe('IUSB    ');
    expect(packet.readUInt8(10)).toBe(32); // header length
    expect(packet.readUInt32LE(12)).toBe(128); // payload length
    expect(packet.readUInt8(17)).toBe(5); // device type: CD-ROM
    expect(packet.readUInt8(19)).toBe(0x80); // direction
    expect(packet.readUInt8(41)).toBe(IusbOpcode.AUTH);
    expect(packet.subarray(63, 79).toString('ascii')).toBe('6CxpkhH5pw1lRvEv');
  });

  it('parses the authentication acknowledgement', () => {
    // The BMC reply: the auth exchange keeps the status at a fixed offset 30.
    const payload = Buffer.alloc(55);
    payload.writeUInt8(IusbOpcode.REDIRECTION_ACK, 9);
    payload.writeUInt8(1, AUTH_STATUS_OFFSET);
    const header = Buffer.alloc(IUSB_HEADER_SIZE);
    Buffer.from('IUSB    ', 'ascii').copy(header, 0);
    header.writeUInt32LE(payload.length, 12);

    const packet = parseIusbPacket(Buffer.concat([header, payload]));
    expect(packet).not.toBeNull();
    expect(packet!.opcode).toBe(IusbOpcode.REDIRECTION_ACK);
    expect(parseAuthAck(packet!).accepted).toBe(true);
  });

  it('recognises a refusal naming the client holding the slot', () => {
    const payload = Buffer.alloc(55);
    payload.writeUInt8(IusbOpcode.REDIRECTION_ACK, 9);
    payload.writeUInt8(0, AUTH_STATUS_OFFSET);
    payload.write('192.168.1.50', AUTH_STATUS_OFFSET + 1, 'ascii');
    const header = Buffer.alloc(IUSB_HEADER_SIZE);
    Buffer.from('IUSB    ', 'ascii').copy(header, 0);
    header.writeUInt32LE(payload.length, 12);

    const ack = parseAuthAck(parseIusbPacket(Buffer.concat([header, payload]))!);
    expect(ack.accepted).toBe(false);
    expect(ack.otherIp).toBe('192.168.1.50');
  });

  it('rejects a packet with a foreign signature', () => {
    const buf = Buffer.alloc(64);
    buf.write('NOTIUSB!', 0, 'ascii');
    expect(parseIusbPacket(buf)).toBeNull();
  });

  /** A request as the BMC sends it: 29 payload bytes, tag and trailing bytes set. */
  function buildRequest(opcode: number): Buffer {
    const payload = Buffer.alloc(IUSB_SCSI_STRUCT_SIZE);
    payload.writeUInt32LE(2048, 0); // length expected
    payload.writeUInt32LE(0x1234, 4); // transfer tag
    payload.writeUInt8(1, 8);
    payload.writeUInt8(opcode, 9);
    const header = Buffer.alloc(IUSB_HEADER_SIZE);
    Buffer.from('IUSB    ', 'ascii').copy(header, 0);
    header.writeUInt32LE(payload.length, 12);
    header.writeUInt8(5, 17);
    header.writeUInt8(3, 23); // device number
    header.writeUInt32LE(42, 24); // sequence number
    header.write('\xc0\x64\x0a\xc2', 28, 'latin1'); // opaque to us, echoed back
    return Buffer.concat([header, payload]);
  }

  it('builds a SCSI reply that stays tied to its request', () => {
    const request = parseIusbPacket(buildRequest(0x28))!; // READ(10)
    const data = Buffer.alloc(CD_SECTOR_SIZE, 0xab);
    const response = buildScsiResponse(request, {
      status: ScsiStatus.GOOD,
      data,
      sense: null,
    });

    expect(response.subarray(0, 8).toString('ascii')).toBe('IUSB    ');
    expect(response.readUInt32LE(12)).toBe(IUSB_SCSI_STRUCT_SIZE + data.length);
    // The tie to the request is preserved, down to the bytes we cannot read.
    expect(response.readUInt32LE(24)).toBe(42);
    expect(response.readUInt8(23)).toBe(3);
    expect(response.readUInt8(19)).toBe(0x80);
    expect(response.subarray(28, 32)).toEqual(request.raw.subarray(28, 32));
    expect(response.readUInt32LE(IUSB_HEADER_SIZE + 4)).toBe(0x1234); // the tag
    // The result: no error, and the length of the data that follows.
    expect(response.readUInt8(IUSB_HEADER_SIZE + 21)).toBe(0);
    expect(response.readUInt32LE(IUSB_HEADER_SIZE + 25)).toBe(data.length);
    expect(response.subarray(IUSB_HEADER_SIZE + IUSB_SCSI_STRUCT_SIZE)).toEqual(data);
  });

  it('reports a failure as a flag with the sense data beside it', () => {
    const request = parseIusbPacket(buildRequest(0x28))!;
    const response = buildScsiResponse(request, {
      status: ScsiStatus.CHECK_CONDITION,
      data: Buffer.alloc(0),
      sense: { key: SenseKey.ILLEGAL_REQUEST, asc: 0x21, ascq: 0x00 },
    });

    expect(response.readUInt8(IUSB_HEADER_SIZE + 21)).toBe(1);
    expect(response.readUInt8(IUSB_HEADER_SIZE + 22)).toBe(SenseKey.ILLEGAL_REQUEST);
    expect(response.readUInt8(IUSB_HEADER_SIZE + 23)).toBe(0x21);
    expect(response.readUInt32LE(IUSB_HEADER_SIZE + 25)).toBe(0);
  });

  it('makes the first 28 header bytes sum to zero', () => {
    const response = buildScsiResponse(parseIusbPacket(buildRequest(0x00))!, {
      status: ScsiStatus.GOOD,
      data: Buffer.alloc(0),
      sense: null,
    });

    let sum = 0;
    for (let i = 0; i < 28; i++) sum += response[i];
    expect(sum & 0xff).toBe(0);
  });
});
