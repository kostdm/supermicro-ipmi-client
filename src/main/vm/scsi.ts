import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * USB CD-ROM emulation on top of an ISO image (the SBC-3 / MMC-6 command set).
 *
 * In the original JViewer this layer lived inside a native library
 * (libjavacdromwrapper), so the decompiled code holds no reference for it —
 * the commands are implemented from the SCSI specifications.
 */

/** CD-ROM sector size. */
export const CD_SECTOR_SIZE = 2048;

/** Sector size for images served as a hard disk or a floppy. */
export const DISK_SECTOR_SIZE = 512;

/** Ceiling for one transfer: 64 CD sectors, as in the original client. */
export const MAX_TRANSFER_SECTORS = 64;

/**
 * The emulated device type. The BMC gives each of them its own port (CD-ROM,
 * floppy, hard disk) and expects the matching set of replies.
 */
export type DeviceKind = 'cdrom' | 'harddisk';

export const ScsiStatus = {
  GOOD: 0x00,
  CHECK_CONDITION: 0x02,
} as const;

/** Sense keys from the SPC-4 table. */
export const SenseKey = {
  NO_SENSE: 0x00,
  NOT_READY: 0x02,
  MEDIUM_ERROR: 0x03,
  ILLEGAL_REQUEST: 0x05,
  UNIT_ATTENTION: 0x06,
} as const;

/** Additional codes: [ASC, ASCQ]. */
const Asc = {
  NO_ADDITIONAL_INFO: [0x00, 0x00],
  INVALID_COMMAND: [0x20, 0x00],
  INVALID_FIELD_IN_CDB: [0x24, 0x00],
  LBA_OUT_OF_RANGE: [0x21, 0x00],
  MEDIUM_NOT_PRESENT: [0x3a, 0x00],
  MEDIUM_MAY_HAVE_CHANGED: [0x28, 0x00],
} as const;

export interface ScsiResult {
  status: number;
  data: Buffer;
  sense: { key: number; asc: number; ascq: number } | null;
}

const GOOD: ScsiResult = { status: ScsiStatus.GOOD, data: Buffer.alloc(0), sense: null };

function ok(data: Buffer = Buffer.alloc(0)): ScsiResult {
  return { status: ScsiStatus.GOOD, data, sense: null };
}

function fail(key: number, asc: readonly [number, number]): ScsiResult {
  return {
    status: ScsiStatus.CHECK_CONDITION,
    data: Buffer.alloc(0),
    sense: { key, asc: asc[0], ascq: asc[1] },
  };
}

/**
 * A virtual CD-ROM: keeps the ISO open and answers SCSI commands.
 */
export class IsoScsiTarget {
  private fd: number | null = null;
  private sectorCount = 0;
  private lastSense: ScsiResult['sense'] = null;
  private readonly kind: DeviceKind;
  private readonly sectorSize: number;

  /**
   * The medium-changed flag.
   *
   * Raised only when the image is swapped inside a running session — the
   * initiator must then receive UNIT ATTENTION, or it keeps treating the old
   * disc's data as current. On a first connection the flag is NOT raised: the
   * BMC probes the device right after authentication and, on receiving CHECK
   * CONDITION, decides the drive is not ready and stops probing.
   */
  private unitAttention = false;

  constructor(
    private readonly path: string,
    kind: DeviceKind = 'cdrom',
  ) {
    this.kind = kind;
    this.sectorSize = kind === 'cdrom' ? CD_SECTOR_SIZE : DISK_SECTOR_SIZE;
  }

  open(): void {
    const stats = statSync(this.path);
    this.fd = openSync(this.path, 'r');
    this.sectorCount = Math.ceil(stats.size / this.sectorSize);
  }

  /**
   * Swaps the image inside a running session. The initiator learns about the
   * change through UNIT ATTENTION on its next command.
   */
  replaceMedium(): void {
    this.unitAttention = true;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  get isOpen(): boolean {
    return this.fd !== null;
  }

  get sectors(): number {
    return this.sectorCount;
  }

  get label(): string {
    return basename(this.path);
  }

  /** Runs a command and returns the status along with any data. */
  execute(cdb: Buffer): ScsiResult {
    const opcode = cdb[0];

    // UNIT ATTENTION is given once, on any command except a sense request.
    if (this.unitAttention && opcode !== 0x03 && opcode !== 0x12) {
      this.unitAttention = false;
      const result = fail(SenseKey.UNIT_ATTENTION, Asc.MEDIUM_MAY_HAVE_CHANGED);
      this.lastSense = result.sense;
      return result;
    }

    const result = this.dispatch(cdb);
    // REQUEST SENSE returns the stored data itself without clearing it.
    if (opcode !== 0x03) this.lastSense = result.sense;
    return result;
  }

  private dispatch(cdb: Buffer): ScsiResult {
    switch (cdb[0]) {
      case 0x00: // TEST UNIT READY
        return this.isOpen ? GOOD : fail(SenseKey.NOT_READY, Asc.MEDIUM_NOT_PRESENT);
      case 0x03:
        return ok(this.requestSense(cdb[4] || 18));
      case 0x12:
        return this.inquiry(cdb);
      case 0x1a:
        return this.modeSense6(cdb);
      case 0x1b: // START STOP UNIT: the guest "ejects" the disc
        return GOOD;
      case 0x1e: // PREVENT ALLOW MEDIUM REMOVAL
        return GOOD;
      case 0x23:
        return this.readFormatCapacities(cdb);
      case 0x25:
        return this.readCapacity10();
      case 0x28:
        return this.read10(cdb);
      case 0x2b: // SEEK(10)
        return GOOD;
      case 0x35: // SYNCHRONIZE CACHE: the medium is read-only
        return GOOD;
      case 0x43:
        return this.readToc(cdb);
      case 0x46:
        return this.getConfiguration(cdb);
      case 0x4a:
        return this.getEventStatusNotification(cdb);
      case 0x51:
        return this.readDiscInformation(cdb);
      case 0x5a:
        return this.modeSense10(cdb);
      case 0xa8:
        return this.read12(cdb);
      case 0xbb: // SET CD SPEED
        return GOOD;
      default:
        return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_COMMAND);
    }
  }

  /** Fixed-format sense data (SPC-4, 18 bytes). */
  private requestSense(allocationLength: number): Buffer {
    const sense = Buffer.alloc(18);
    sense.writeUInt8(0x70, 0); // current error, fixed format
    sense.writeUInt8(this.lastSense?.key ?? SenseKey.NO_SENSE, 2);
    sense.writeUInt8(10, 7); // additional sense length
    sense.writeUInt8(this.lastSense?.asc ?? 0, 12);
    sense.writeUInt8(this.lastSense?.ascq ?? 0, 13);
    this.lastSense = null;
    return sense.subarray(0, Math.min(allocationLength, sense.length));
  }

  private inquiry(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(3);

    // Vital product data pages are requested through the EVPD bit.
    if (cdb[1] & 0x01) {
      const page = cdb[2];
      if (page === 0x00) {
        // The list of supported pages.
        const data = Buffer.from([0x05, 0x00, 0x00, 0x02, 0x00, 0x80]);
        return ok(data.subarray(0, Math.min(allocationLength, data.length)));
      }
      if (page === 0x80) {
        // The device serial number.
        const serial = Buffer.from('0123456789ABCDEF', 'ascii');
        const data = Buffer.alloc(4 + serial.length);
        data.writeUInt8(0x05, 0);
        data.writeUInt8(0x80, 1);
        data.writeUInt8(serial.length, 3);
        serial.copy(data, 4);
        return ok(data.subarray(0, Math.min(allocationLength, data.length)));
      }
      return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_FIELD_IN_CDB);
    }

    const cdrom = this.kind === 'cdrom';
    const data = Buffer.alloc(36);
    // 0x05 is a CD/DVD drive, 0x00 a direct-access block device.
    data.writeUInt8(cdrom ? 0x05 : 0x00, 0);
    data.writeUInt8(0x80, 1); // removable medium
    data.writeUInt8(0x00, 2); // version: no ANSI level claimed
    data.writeUInt8(0x21, 3); // response format 1, HiSup
    data.writeUInt8(31, 4); // length of the remaining data
    data.write('AMI     ', 8, 'ascii'); // vendor, 8 bytes
    data.write(cdrom ? 'Virtual CDROM   ' : 'Virtual HDD     ', 16, 'ascii'); // model
    data.write('1.00', 32, 'ascii'); // revision, 4 bytes
    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }

  private modeSense6(cdb: Buffer): ScsiResult {
    const allocationLength = cdb[4];
    const page = cdb[2] & 0x3f;
    const pages = this.buildModePages(page);
    if (!pages) return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_FIELD_IN_CDB);

    const data = Buffer.alloc(4 + pages.length);
    data.writeUInt8(3 + pages.length, 0); // data length excluding the first byte
    data.writeUInt8(0x01, 1); // medium type: 120 mm disc
    data.writeUInt8(0x80, 2); // write protected
    data.writeUInt8(0, 3); // no block descriptors
    pages.copy(data, 4);
    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }

  private modeSense10(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(7);
    const page = cdb[2] & 0x3f;
    const pages = this.buildModePages(page);
    if (!pages) return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_FIELD_IN_CDB);

    const data = Buffer.alloc(8 + pages.length);
    data.writeUInt16BE(6 + pages.length, 0);
    data.writeUInt8(0x01, 2);
    data.writeUInt8(0x80, 3);
    pages.copy(data, 8);
    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }

  /** Mode pages: returns null when an unsupported page is requested. */
  private buildModePages(page: number): Buffer | null {
    // 0x2A is the MMC drive capabilities page, 0x3F means "all pages".
    if (page === 0x2a || page === 0x3f) {
      const caps = Buffer.alloc(28);
      caps.writeUInt8(0x2a, 0);
      caps.writeUInt8(26, 1); // page length
      caps.writeUInt8(0x03, 2); // reads CD-R and CD-RW
      caps.writeUInt8(0x00, 3); // no writing
      caps.writeUInt8(0x71, 4); // multi-session, mode 2 and audio capable
      caps.writeUInt16BE(706, 8); // maximum speed, KB/s
      caps.writeUInt16BE(0, 10); // buffer size
      caps.writeUInt16BE(706, 14); // current speed
      return caps;
    }
    if (page === 0x01) {
      // Read error recovery parameters.
      const recovery = Buffer.alloc(12);
      recovery.writeUInt8(0x01, 0);
      recovery.writeUInt8(10, 1);
      return recovery;
    }
    return null;
  }

  private readFormatCapacities(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(7);
    const data = Buffer.alloc(12);
    data.writeUInt8(8, 3); // capacity list length
    data.writeUInt32BE(this.sectorCount, 4);
    data.writeUInt8(0x02, 8); // current format
    // The block size is stored in three bytes.
    data.writeUInt8((this.sectorSize >> 16) & 0xff, 9);
    data.writeUInt8((this.sectorSize >> 8) & 0xff, 10);
    data.writeUInt8(this.sectorSize & 0xff, 11);
    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }

  private readCapacity10(): ScsiResult {
    if (!this.isOpen) return fail(SenseKey.NOT_READY, Asc.MEDIUM_NOT_PRESENT);
    const data = Buffer.alloc(8);
    // What is returned is the address of the last block, not the block count.
    data.writeUInt32BE(Math.max(0, this.sectorCount - 1), 0);
    data.writeUInt32BE(this.sectorSize, 4);
    return ok(data);
  }

  private read10(cdb: Buffer): ScsiResult {
    return this.readSectors(cdb.readUInt32BE(2), cdb.readUInt16BE(7));
  }

  private read12(cdb: Buffer): ScsiResult {
    return this.readSectors(cdb.readUInt32BE(2), cdb.readUInt32BE(6));
  }

  private readSectors(lba: number, count: number): ScsiResult {
    if (!this.isOpen || this.fd === null) {
      return fail(SenseKey.NOT_READY, Asc.MEDIUM_NOT_PRESENT);
    }
    if (count === 0) return GOOD;
    if (lba >= this.sectorCount || lba + count > this.sectorCount) {
      return fail(SenseKey.ILLEGAL_REQUEST, Asc.LBA_OUT_OF_RANGE);
    }
    // The IUSB protocol caps how much can travel in one transfer.
    if (count * this.sectorSize > MAX_TRANSFER_SECTORS * CD_SECTOR_SIZE) {
      return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_FIELD_IN_CDB);
    }

    const data = Buffer.alloc(count * this.sectorSize);
    const read = readSync(this.fd, data, 0, data.length, lba * this.sectorSize);
    // The tail of the image may be shorter than a sector — the rest is already zeroed.
    if (read <= 0) return fail(SenseKey.MEDIUM_ERROR, Asc.NO_ADDITIONAL_INFO);
    return ok(data);
  }

  /** The disc table of contents: one data track spanning the whole image. */
  private readToc(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(7);
    const format = cdb[2] & 0x0f;
    const msf = (cdb[1] & 0x02) !== 0;

    if (format === 0) {
      // Descriptors: track 1 and the lead-out marker (0xAA).
      const data = Buffer.alloc(20);
      data.writeUInt16BE(18, 0); // data length
      data.writeUInt8(1, 2); // first track
      data.writeUInt8(1, 3); // last track

      data.writeUInt8(0x14, 5); // ADR=1, control=4: a data track
      data.writeUInt8(1, 6); // track number
      writeTocAddress(data, 8, 0, msf);

      data.writeUInt8(0x14, 13);
      data.writeUInt8(0xaa, 14); // lead-out marker
      writeTocAddress(data, 16, this.sectorCount, msf);

      return ok(data.subarray(0, Math.min(allocationLength, data.length)));
    }

    if (format === 1) {
      // Session information.
      const data = Buffer.alloc(12);
      data.writeUInt16BE(10, 0);
      data.writeUInt8(1, 2);
      data.writeUInt8(1, 3);
      data.writeUInt8(0x14, 5);
      data.writeUInt8(1, 6);
      writeTocAddress(data, 8, 0, msf);
      return ok(data.subarray(0, Math.min(allocationLength, data.length)));
    }

    return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_FIELD_IN_CDB);
  }

  /** The device profile: a CD-ROM is claimed. */
  private getConfiguration(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(7);
    const data = Buffer.alloc(40);
    data.writeUInt32BE(36, 0); // data length
    data.writeUInt16BE(0x0008, 6); // current profile: CD-ROM

    // The "profile list" descriptor.
    data.writeUInt16BE(0x0000, 8);
    data.writeUInt8(0x03, 10); // current, persistent
    data.writeUInt8(4, 11);
    data.writeUInt16BE(0x0008, 12);
    data.writeUInt8(0x01, 14); // the profile is active

    // The "core" descriptor.
    data.writeUInt16BE(0x0001, 16);
    data.writeUInt8(0x03, 18);
    data.writeUInt8(8, 19);
    data.writeUInt32BE(0x00000007, 20); // physical interface: USB

    // The "removable medium" descriptor.
    data.writeUInt16BE(0x0003, 28);
    data.writeUInt8(0x03, 30);
    data.writeUInt8(4, 31);
    data.writeUInt8(0x29, 32); // tray loader, can eject

    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }

  private getEventStatusNotification(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(7);
    // Only polled requests are answered; otherwise the command is unsupported.
    if ((cdb[1] & 0x01) === 0) return fail(SenseKey.ILLEGAL_REQUEST, Asc.INVALID_FIELD_IN_CDB);

    const data = Buffer.alloc(8);
    data.writeUInt16BE(6, 0); // data length
    data.writeUInt8(0x04, 2); // event class: media
    data.writeUInt8(0x04, 3); // supported classes
    data.writeUInt8(0x00, 4); // no events
    data.writeUInt8(this.isOpen ? 0x02 : 0x00, 5); // medium present
    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }

  private readDiscInformation(cdb: Buffer): ScsiResult {
    const allocationLength = cdb.readUInt16BE(7);
    const data = Buffer.alloc(34);
    data.writeUInt16BE(32, 0);
    data.writeUInt8(0x0e, 2); // disc finalised, last session complete
    data.writeUInt8(1, 3); // first track number
    data.writeUInt8(1, 4); // number of sessions
    data.writeUInt8(1, 5); // first track of the last session
    data.writeUInt8(1, 6); // last track of the last session
    data.writeUInt8(0x00, 8); // disc type: CD-ROM
    return ok(data.subarray(0, Math.min(allocationLength, data.length)));
  }
}

/**
 * A table-of-contents address: either an LBA or MSF (minutes/seconds/frames).
 * MSF counts from the two-second lead-in.
 */
function writeTocAddress(buf: Buffer, offset: number, lba: number, msf: boolean): void {
  if (!msf) {
    buf.writeUInt32BE(lba, offset);
    return;
  }
  const total = lba + 150;
  buf.writeUInt8(0, offset);
  buf.writeUInt8(Math.floor(total / (60 * 75)), offset + 1);
  buf.writeUInt8(Math.floor(total / 75) % 60, offset + 2);
  buf.writeUInt8(total % 75, offset + 3);
}
