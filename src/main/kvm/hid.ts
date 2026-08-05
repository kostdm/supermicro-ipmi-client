import type { MouseMode } from '@shared/types';
import { Pkt, buildHeader } from './ivtp';
import { ModifierBit, isLockKey, isModifier, toHidUsage } from './keymap';

/**
 * Building the keyboard and mouse HID packets.
 *
 * Every packet is an IVTP header (type=1) + a 32-byte IUSB header + the HID
 * report itself. The layout was taken from JViewer's USBKeyboardRep.java and
 * USBMouseRep.java.
 */

const IUSB_HEADER_OFFSET = 8;
const IUSB_HEADER_SIZE = 32;
/** Offset of the checksum byte inside the packet. */
const CHECKSUM_OFFSET = 19;
/** Offset of the HID report length field. */
const REPORT_LEN_OFFSET = 40;
const REPORT_OFFSET = 41;

const IUSB_SIGNATURE = Buffer.from('IUSB    ', 'ascii');

const Device = {
  KEYBOARD: 0x30,
  MOUSE: 0x31,
} as const;

const Protocol = {
  KEYBOARD: 0x10,
  MOUSE: 0x20,
} as const;

/** The packet is addressed to the remote side. */
const FROM_REMOTE = 0x80;

const KEYBOARD_REPORT_SIZE = 8;
const MOUSE_ABS_REPORT_SIZE = 6;
const MOUSE_REL_REPORT_SIZE = 4;

/** The largest absolute coordinate the BMC understands. */
const ABS_COORD_MAX = 32767;

/** A relative delta in one packet is limited by a signed byte. */
const REL_STEP_LIMIT = 126;

export const MouseButton = {
  LEFT: 1,
  RIGHT: 2,
  MIDDLE: 4,
} as const;

/**
 * Assembles a packet: IVTP header, IUSB header, report length and the report.
 * The checksum is computed over the 32 bytes of the IUSB header.
 */
function buildHidPacket(
  device: number,
  protocol: number,
  interfaceNum: number,
  sequence: number,
  report: Buffer,
): Buffer {
  const packet = Buffer.alloc(REPORT_OFFSET + report.length);
  const pktSize = packet.length - 8;

  buildHeader(Pkt.HID, pktSize, 0).copy(packet, 0);

  IUSB_SIGNATURE.copy(packet, IUSB_HEADER_OFFSET);
  packet.writeUInt8(1, 16); // major
  packet.writeUInt8(0, 17); // minor
  packet.writeUInt8(IUSB_HEADER_SIZE, 18);
  // packet[19] is the checksum, filled in below.
  packet.writeInt32LE(report.length + 1, 20); // data length including the length byte
  packet.writeUInt8(0, 24);
  packet.writeUInt8(device, 25);
  packet.writeUInt8(protocol, 26);
  packet.writeUInt8(FROM_REMOTE, 27);
  packet.writeUInt8(2, 28); // device number
  packet.writeUInt8(interfaceNum, 29);
  packet.writeUInt32LE(sequence >>> 0, 32);

  packet.writeUInt8(report.length, REPORT_LEN_OFFSET);
  report.copy(packet, REPORT_OFFSET);

  let sum = 0;
  for (let i = IUSB_HEADER_OFFSET; i < IUSB_HEADER_OFFSET + IUSB_HEADER_SIZE; i++) {
    sum = (sum + packet[i]) & 0xff;
  }
  packet.writeUInt8((256 - sum) & 0xff, CHECKSUM_OFFSET);

  return packet;
}

/**
 * Keyboard state: the modifier mask and a packet counter.
 *
 * The BMC runs in auto-keybreak mode: on an ordinary key press the client
 * sets the auto-release flag and the server generates the key-up itself. So
 * for the key-up of an ordinary key no packet is sent at all — otherwise
 * characters come out doubled.
 */
export class KeyboardState {
  private modifiers = 0;
  private sequence = 0;

  /** Clears the modifiers — for instance when the window loses focus. */
  reset(): Buffer {
    this.modifiers = 0;
    return this.buildReport(0, false);
  }

  get modifierMask(): number {
    return this.modifiers;
  }

  /**
   * Returns a packet for the keyboard event, or null when there is nothing to send.
   */
  handle(code: string, pressed: boolean): Buffer | null {
    if (isModifier(code)) {
      const bit = ModifierBit[code];
      if (pressed) this.modifiers |= bit;
      else this.modifiers &= ~bit;
      // Modifiers travel in a report of their own, with no scan code.
      return this.buildReport(0, false);
    }

    const usage = toHidUsage(code);
    if (usage === undefined) return null;

    if (pressed) {
      return this.buildReport(usage, true);
    }

    // The original repeats PrintScreen on release too, lock keys need an
    // explicit key-up, and the server releases everything else itself.
    if (code === 'PrintScreen') return this.buildReport(usage, true);
    if (isLockKey(code)) return this.buildReport(0, false);
    return null;
  }

  /**
   * Report: [0] modifiers, [1] the auto-release flag (reserved in standard
   * HID), [2..7] key slots — the BMC only reads the first one.
   */
  private buildReport(usage: number, autoBreak: boolean): Buffer {
    const report = Buffer.alloc(KEYBOARD_REPORT_SIZE);
    report.writeUInt8(this.modifiers, 0);
    report.writeUInt8(autoBreak ? 1 : 0, 1);
    report.writeUInt8(usage, 2);
    return buildHidPacket(
      Device.KEYBOARD,
      Protocol.KEYBOARD,
      0,
      this.sequence++,
      report,
    );
  }
}

/** Mouse state: buttons, the last position and a packet counter. */
export class MouseState {
  private sequence = 0;
  private buttons = 0;
  private lastX = 0;
  private lastY = 0;

  /**
   * Absolute mode: coordinates are scaled into 0..32767 relative to the
   * visible screen resolution.
   */
  absolute(
    x: number,
    y: number,
    buttons: number,
    wheel: number,
    screenWidth: number,
    screenHeight: number,
  ): Buffer {
    this.buttons = buttons;
    this.lastX = x;
    this.lastY = y;

    const scale = (value: number, size: number) => {
      if (size <= 0) return 0;
      const scaled = Math.round((value * ABS_COORD_MAX) / size);
      return Math.max(0, Math.min(ABS_COORD_MAX, scaled));
    };

    const report = Buffer.alloc(MOUSE_ABS_REPORT_SIZE);
    report.writeUInt8(buttons, 0);
    report.writeInt16LE(scale(x, screenWidth), 1);
    report.writeInt16LE(scale(y, screenHeight), 3);
    report.writeInt8(clampWheel(wheel), 5);
    return buildHidPacket(Device.MOUSE, Protocol.MOUSE, 1, this.sequence++, report);
  }

  /**
   * Relative mode: a delta does not always fit into a signed byte, so large
   * movements are split across several packets.
   */
  relative(dx: number, dy: number, buttons: number, wheel: number): Buffer[] {
    this.buttons = buttons;
    const packets: Buffer[] = [];

    let remainingX = Math.trunc(dx);
    let remainingY = Math.trunc(dy);

    do {
      const stepX = clampStep(remainingX);
      const stepY = clampStep(remainingY);
      remainingX -= stepX;
      remainingY -= stepY;

      const report = Buffer.alloc(MOUSE_REL_REPORT_SIZE);
      report.writeUInt8(buttons, 0);
      report.writeInt8(stepX, 1);
      report.writeInt8(stepY, 2);
      // The wheel is only sent with the first packet of a series.
      report.writeInt8(packets.length === 0 ? clampWheel(wheel) : 0, 3);
      packets.push(buildHidPacket(Device.MOUSE, Protocol.MOUSE, 1, this.sequence++, report));
    } while (remainingX !== 0 || remainingY !== 0);

    return packets;
  }

  /**
   * A wheel event. In absolute mode the current coordinates matter: the
   * original JViewer sends (0,0) here and drags the cursor into a corner.
   */
  wheelOnly(
    wheel: number,
    mode: MouseMode,
    screenWidth: number,
    screenHeight: number,
  ): Buffer[] {
    if (mode === 'relative') {
      return this.relative(0, 0, this.buttons, wheel);
    }
    return [
      this.absolute(
        this.lastX,
        this.lastY,
        this.buttons,
        wheel,
        screenWidth,
        screenHeight,
      ),
    ];
  }
}

function clampStep(value: number): number {
  if (value > REL_STEP_LIMIT) return REL_STEP_LIMIT;
  if (value < -REL_STEP_LIMIT) return -REL_STEP_LIMIT;
  return value;
}

/** The BMC only understands the scroll direction. */
function clampWheel(wheel: number): number {
  if (wheel > 0) return 1;
  if (wheel < 0) return -1;
  return 0;
}
