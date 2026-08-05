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

  it('rejects an unknown command', () => {
    const result = open().execute(Buffer.from([0xff]));
    expect(result.status).toBe(ScsiStatus.CHECK_CONDITION);
    expect(result.sense?.key).toBe(SenseKey.ILLEGAL_REQUEST);
    expect(result.sense?.asc).toBe(0x20); // invalid command
  });
});

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
    // The BMC reply: the status sits right after the housekeeping structure.
    const payload = Buffer.alloc(55);
    payload.writeUInt8(IusbOpcode.REDIRECTION_ACK, 9);
    payload.writeUInt8(1, IUSB_SCSI_STRUCT_SIZE);
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
    payload.writeUInt8(0, IUSB_SCSI_STRUCT_SIZE);
    payload.write('192.168.1.50', IUSB_SCSI_STRUCT_SIZE + 1, 'ascii');
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

  it('builds a SCSI reply that stays tied to its request', () => {
    const requestPayload = Buffer.alloc(IUSB_SCSI_STRUCT_SIZE);
    requestPayload.writeUInt8(0x28, 9); // READ(10)
    const requestHeader = Buffer.alloc(IUSB_HEADER_SIZE);
    Buffer.from('IUSB    ', 'ascii').copy(requestHeader, 0);
    requestHeader.writeUInt32LE(requestPayload.length, 12);
    requestHeader.writeUInt8(5, 17);
    requestHeader.writeUInt32LE(42, 24); // sequence number
    requestHeader.writeUInt8(3, 23); // device number

    const request = parseIusbPacket(Buffer.concat([requestHeader, requestPayload]))!;
    const data = Buffer.alloc(CD_SECTOR_SIZE, 0xab);
    const response = buildScsiResponse(request, {
      status: ScsiStatus.GOOD,
      data,
      sense: null,
    });

    expect(response.subarray(0, 8).toString('ascii')).toBe('IUSB    ');
    expect(response.readUInt32LE(12)).toBe(IUSB_SCSI_STRUCT_SIZE + data.length);
    // The tie to the request is preserved.
    expect(response.readUInt32LE(24)).toBe(42);
    expect(response.readUInt8(23)).toBe(3);
    expect(response.readUInt8(19)).toBe(0x80);
    // Data length and status.
    expect(response.readUInt32LE(IUSB_HEADER_SIZE)).toBe(data.length);
    expect(response.readUInt8(IUSB_HEADER_SIZE + 25)).toBe(ScsiStatus.GOOD);
    expect(response.subarray(IUSB_HEADER_SIZE + IUSB_SCSI_STRUCT_SIZE)).toEqual(data);
  });
});
