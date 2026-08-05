import { AppError } from '@shared/i18n';
import { NetFn } from './protocol';
import type { IpmiSession } from './session';

/**
 * The IPMI commands the application needs: chassis state, sensors, the event
 * log, power control and boot order.
 *
 * Anything the user will read is returned as a translation key rather than
 * prose — the renderer owns the language.
 */

// --- chassis and power ---

const CMD_GET_CHASSIS_STATUS = 0x01;
const CMD_CHASSIS_CONTROL = 0x02;
const CMD_SET_BOOT_OPTIONS = 0x08;

export interface ChassisStatus {
  powerOn: boolean;
  powerOverload: boolean;
  powerInterlock: boolean;
  powerFault: boolean;
  powerControlFault: boolean;
  /** Translation key of the power restore policy. */
  powerRestorePolicy: string;
  /** Translation key of the last power event. */
  lastPowerEvent: string;
  chassisIntrusion: boolean;
  frontPanelLockout: boolean;
  driveFault: boolean;
  coolingFault: boolean;
  /** Whether the chassis identify LED is lit. */
  identifyActive: boolean;
}

/**
 * Layout of the Get Chassis Status response (IPMI specification, 28.2):
 *   byte 1 — current power state,
 *   byte 2 — last power event,
 *   byte 3 — other chassis states.
 */
export async function getChassisStatus(session: IpmiSession): Promise<ChassisStatus> {
  const data = await session.command(NetFn.CHASSIS, CMD_GET_CHASSIS_STATUS);
  if (data.length < 3) throw new AppError('error.shortChassisStatus');

  const power = data[0];
  const last = data[1];
  const misc = data[2];

  return {
    powerOn: (power & 0x01) !== 0,
    powerOverload: (power & 0x02) !== 0,
    powerInterlock: (power & 0x04) !== 0,
    powerFault: (power & 0x08) !== 0,
    powerControlFault: (power & 0x10) !== 0,
    powerRestorePolicy: describeRestorePolicy((power >> 5) & 0x03),
    lastPowerEvent: describeLastPowerEvent(last),
    chassisIntrusion: (misc & 0x01) !== 0,
    frontPanelLockout: (misc & 0x02) !== 0,
    driveFault: (misc & 0x04) !== 0,
    coolingFault: (misc & 0x08) !== 0,
    // Bits 5:4 — LED state: 0 off, 1 temporary, 2 permanent.
    identifyActive: ((misc >> 4) & 0x03) !== 0,
  };
}

function describeRestorePolicy(bits: number): string {
  switch (bits) {
    case 0:
      return 'restorePolicy.off';
    case 1:
      return 'restorePolicy.previous';
    case 2:
      return 'restorePolicy.on';
    default:
      return 'restorePolicy.unknown';
  }
}

function describeLastPowerEvent(bits: number): string {
  if (bits & 0x01) return 'powerEvent.acLost';
  if (bits & 0x02) return 'powerEvent.overload';
  if (bits & 0x04) return 'powerEvent.interlock';
  if (bits & 0x08) return 'powerEvent.fault';
  if (bits & 0x10) return 'powerEvent.ipmiCommand';
  return 'powerEvent.none';
}

export const ChassisControl = {
  POWER_DOWN: 0x00,
  POWER_UP: 0x01,
  POWER_CYCLE: 0x02,
  HARD_RESET: 0x03,
  PULSE_DIAGNOSTIC: 0x04,
  SOFT_SHUTDOWN: 0x05,
} as const;

export async function chassisControl(session: IpmiSession, action: number): Promise<void> {
  await session.command(NetFn.CHASSIS, CMD_CHASSIS_CONTROL, Buffer.from([action]));
}

export const BootDevice = {
  NONE: 0x00,
  PXE: 0x01,
  DISK: 0x02,
  DIAGNOSTIC: 0x03,
  CDROM: 0x05,
  BIOS_SETUP: 0x06,
} as const;

/**
 * Sets the boot device for the next start.
 *
 * The acknowledgement flag (parameter 3) has to be cleared first, or some
 * BMCs ignore the choice.
 */
export async function setBootDevice(
  session: IpmiSession,
  device: number,
  persistent = false,
): Promise<void> {
  // Parameter 3: clear the acknowledgement flag.
  await session.command(NetFn.CHASSIS, CMD_SET_BOOT_OPTIONS, Buffer.from([0x03, 0x00]));

  // Parameter 5: boot flags. Bit 7 of the first byte means "flags are valid",
  // bit 6 keeps the choice for subsequent boots.
  const flags = 0x80 | (persistent ? 0x40 : 0x00);
  await session.command(
    NetFn.CHASSIS,
    CMD_SET_BOOT_OPTIONS,
    Buffer.from([0x05, flags, (device << 2) & 0x3c, 0x00, 0x00, 0x00]),
  );
}

// --- sensors ---

const CMD_RESERVE_SDR_REPOSITORY = 0x22;
const CMD_GET_SDR = 0x23;
const CMD_GET_SENSOR_READING = 0x2d;

export interface SensorReading {
  id: number;
  name: string;
  /** Converted value, or null when the sensor is unavailable. */
  value: number | null;
  /** Unit code, translated in the renderer. */
  unit: string;
  /** Discrete sensors carry no numeric value. */
  discrete: boolean;
  /** Translation keys of the active threshold states. */
  states: string[];
  ok: boolean;
}

/**
 * Units from table 43-15 of the specification (the part in use). These are
 * codes, not display text: the renderer turns them into localised symbols.
 */
const UNITS: Record<number, string> = {
  0: '',
  1: 'C',
  2: 'F',
  3: 'K',
  4: 'V',
  5: 'A',
  6: 'W',
  7: 'J',
  18: 'RPM',
  19: 'Hz',
};

interface SdrRecord {
  sensorNumber: number;
  name: string;
  unit: string;
  /** A sensor with a numeric value and linearisation. */
  analog: boolean;
  /**
   * Event/Reading type code. 0x01 means a threshold sensor: only there does
   * the third byte of the Get Sensor Reading response mean a threshold
   * crossing. On discrete sensors the same bits mean something else entirely.
   */
  thresholdBased: boolean;
  m: number;
  b: number;
  resultExponent: number;
  bExponent: number;
  /** true — the raw value is signed. */
  signed: boolean;
}

/**
 * Reads the SDR records describing the sensors.
 *
 * The repository is walked through a chain of record IDs: every response
 * carries the ID of the next record, and 0xFFFF marks the end.
 */
export async function readSdrRecords(session: IpmiSession, limit = 256): Promise<SdrRecord[]> {
  const reservation = await session.command(NetFn.STORAGE, CMD_RESERVE_SDR_REPOSITORY);
  const reservationId = reservation.length >= 2 ? reservation.readUInt16LE(0) : 0;

  const records: SdrRecord[] = [];
  let recordId = 0x0000;

  for (let i = 0; i < limit && recordId !== 0xffff; i++) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(reservationId, 0);
    header.writeUInt16LE(recordId, 2);
    header.writeUInt8(0, 4); // offset inside the record
    header.writeUInt8(0xff, 5); // read the whole record

    let response: Buffer;
    try {
      response = await session.command(NetFn.STORAGE, CMD_GET_SDR, header);
    } catch {
      // Some BMCs refuse to return a whole record — skip it and move on.
      break;
    }
    if (response.length < 3) break;

    const nextId = response.readUInt16LE(0);
    const body = response.subarray(2);
    const parsed = parseSdrRecord(body);
    if (parsed) records.push(parsed);

    if (nextId === recordId) break;
    recordId = nextId;
  }

  return records;
}

/** Parses record types 01h (full) and 02h (compact). */
function parseSdrRecord(body: Buffer): SdrRecord | null {
  if (body.length < 8) return null;
  const recordType = body[3];
  if (recordType !== 0x01 && recordType !== 0x02) return null;

  const sensorNumber = body[7];
  // Byte 14 of the record (index 13) is the Event/Reading Type Code.
  const thresholdBased = body[13] === 0x01;

  if (recordType === 0x01) {
    if (body.length < 48) return null;
    const unitsByte = body[20];
    const baseUnit = body[21];
    const m = decodeM(body[24], body[25]);
    const b = decodeB(body[26], body[27]);
    const exponents = body[29];
    // Bits 7:6 select the format: 11b means the sensor returns no number.
    const format = unitsByte & 0xc0;

    return {
      sensorNumber,
      // ID String Type/Length sits at byte 48 (index 47); the string follows.
      name: decodeSdrName(body, 48),
      unit: UNITS[baseUnit] ?? '',
      analog: format !== 0xc0,
      thresholdBased,
      m,
      b,
      resultExponent: signedNibble(exponents >> 4),
      bExponent: signedNibble(exponents & 0x0f),
      signed: format === 0x40 || format === 0x80,
    };
  }

  // Compact record: ID String Type/Length at byte 32 (index 31), string at 32.
  if (body.length < 33) return null;
  return {
    sensorNumber,
    name: decodeSdrName(body, 32),
    unit: UNITS[body[21]] ?? '',
    analog: false,
    thresholdBased,
    m: 1,
    b: 0,
    resultExponent: 0,
    bExponent: 0,
    signed: false,
  };
}

/** M and B are 10-bit signed values split across two bytes. */
function decodeM(low: number, high: number): number {
  const raw = ((high & 0xc0) << 2) | low;
  return raw > 511 ? raw - 1024 : raw;
}

function decodeB(low: number, high: number): number {
  const raw = ((high & 0xc0) << 2) | low;
  return raw > 511 ? raw - 1024 : raw;
}

function signedNibble(value: number): number {
  return value > 7 ? value - 16 : value;
}

/**
 * The sensor name sits at the end of the record: a type/length byte, then the
 * characters. Only 8-bit ASCII is supported — every BMC seen so far uses it.
 */
function decodeSdrName(body: Buffer, offset: number): string {
  if (offset >= body.length) return '';
  const length = body[offset - 1] & 0x1f;
  const raw = body.subarray(offset, offset + length);
  return raw.toString('ascii').replace(/[^\x20-\x7e]/g, '').trim();
}

/** Reads the current readings of every sensor in the SDR. */
export async function readSensors(session: IpmiSession): Promise<SensorReading[]> {
  const records = await readSdrRecords(session);
  const readings: SensorReading[] = [];

  for (const record of records) {
    const response = await session.tryCommand(
      NetFn.SENSOR,
      CMD_GET_SENSOR_READING,
      Buffer.from([record.sensorNumber]),
    );

    if (response.completionCode !== 0 || response.data.length < 2) {
      readings.push({
        id: record.sensorNumber,
        name: record.name,
        value: null,
        unit: record.unit,
        discrete: !record.analog,
        states: [],
        ok: false,
      });
      continue;
    }

    const raw = response.data[0];
    const flags = response.data[1];
    // Bit 5 clear — no reading available (sensor disabled or not yet scanned).
    const available = (flags & 0x20) === 0;

    // Threshold states only mean anything on threshold sensors: on discrete
    // ones the same bits encode states specific to their type.
    const states =
      record.thresholdBased && response.data.length >= 3
        ? decodeThresholdStates(response.data[2])
        : [];

    readings.push({
      id: record.sensorNumber,
      name: record.name,
      value: available && record.analog ? convertReading(record, raw) : null,
      unit: record.unit,
      discrete: !record.analog,
      states,
      ok: available,
    });
  }

  return readings;
}

/** Linear conversion of a raw value: (M*raw + B*10^Bexp) * 10^Rexp. */
function convertReading(record: SdrRecord, raw: number): number {
  const value = record.signed && raw > 127 ? raw - 256 : raw;
  const result =
    (record.m * value + record.b * Math.pow(10, record.bExponent)) *
    Math.pow(10, record.resultExponent);
  return Number(result.toFixed(3));
}

/** Threshold-crossing bits from Get Sensor Reading (event type 0x01 only). */
function decodeThresholdStates(byte: number): string[] {
  const states: string[] = [];
  if (byte & 0x01) states.push('threshold.lowerNonCritical');
  if (byte & 0x02) states.push('threshold.lowerCritical');
  if (byte & 0x04) states.push('threshold.lowerNonRecoverable');
  if (byte & 0x08) states.push('threshold.upperNonCritical');
  if (byte & 0x10) states.push('threshold.upperCritical');
  if (byte & 0x20) states.push('threshold.upperNonRecoverable');
  return states;
}

// --- event log ---

const CMD_GET_SEL_INFO = 0x40;
const CMD_GET_SEL_ENTRY = 0x43;

export interface SelEntry {
  id: number;
  /** When the event happened; null for records without a timestamp. */
  timestamp: Date | null;
  sensorType: number;
  sensorNumber: number;
  eventDirection: 'assert' | 'deassert';
  raw: Buffer;
}

export async function getSelInfo(session: IpmiSession): Promise<{ entries: number }> {
  const data = await session.command(NetFn.STORAGE, CMD_GET_SEL_INFO);
  return { entries: data.length >= 3 ? data.readUInt16LE(1) : 0 };
}

/** Reads the system event log, starting from the oldest records. */
export async function readSel(session: IpmiSession, limit = 100): Promise<SelEntry[]> {
  const entries: SelEntry[] = [];
  let recordId = 0x0000;

  for (let i = 0; i < limit && recordId !== 0xffff; i++) {
    const request = Buffer.alloc(6);
    request.writeUInt16LE(0, 0); // no reservation needed to read a whole record
    request.writeUInt16LE(recordId, 2);
    request.writeUInt8(0, 4);
    request.writeUInt8(0xff, 5);

    let response: Buffer;
    try {
      response = await session.command(NetFn.STORAGE, CMD_GET_SEL_ENTRY, request);
    } catch {
      break;
    }
    if (response.length < 18) break;

    const nextId = response.readUInt16LE(0);
    const record = response.subarray(2);
    const recordType = record[2];

    // Only system events (type 0x02) carry a timestamp.
    const seconds = record.readUInt32LE(3);
    entries.push({
      id: record.readUInt16LE(0),
      timestamp: recordType === 0x02 && seconds > 0 ? new Date(seconds * 1000) : null,
      sensorType: record[10],
      sensorNumber: record[11],
      eventDirection: (record[12] & 0x80) === 0 ? 'assert' : 'deassert',
      raw: Buffer.from(record),
    });

    if (nextId === recordId) break;
    recordId = nextId;
  }

  return entries;
}

// --- device information ---

const CMD_GET_DEVICE_ID = 0x01;

export interface DeviceInfo {
  deviceId: number;
  firmwareVersion: string;
  ipmiVersion: string;
  manufacturerId: number;
  productId: number;
}

export async function getDeviceId(session: IpmiSession): Promise<DeviceInfo> {
  const data = await session.command(NetFn.APP, CMD_GET_DEVICE_ID);
  if (data.length < 11) throw new AppError('error.shortDeviceId');

  // The minor firmware version is stored as BCD.
  const minor = data[3].toString(16).padStart(2, '0');
  return {
    deviceId: data[0],
    firmwareVersion: `${data[2] & 0x7f}.${minor}`,
    ipmiVersion: `${data[4] & 0x0f}.${data[4] >> 4}`,
    manufacturerId: data[6] | (data[7] << 8) | (data[8] << 16),
    productId: data.readUInt16LE(9),
  };
}
