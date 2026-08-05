import { describe, it, expect } from 'vitest';
import { KeyboardState, MouseState } from '../src/main/kvm/hid';

/**
 * The packet layout is checked against JViewer's USBKeyboardRep.java and
 * USBMouseRep.java.
 */

const IUSB_START = 8;
const IUSB_END = 40;

function iusbChecksumIsValid(packet: Buffer): boolean {
  let sum = 0;
  for (let i = IUSB_START; i < IUSB_END; i++) sum = (sum + packet[i]) & 0xff;
  // The checksum byte is inside the range, so the total must come to zero.
  return sum === 0;
}

function readIvtp(packet: Buffer) {
  return {
    type: packet.readUInt16LE(0),
    pktSize: packet.readInt32LE(2),
    status: packet.readUInt16LE(6),
  };
}

describe('keyboard', () => {
  it('builds a key-press packet with the right layout', () => {
    const kb = new KeyboardState();
    const packet = kb.handle('KeyA', true);

    expect(packet).not.toBeNull();
    const buf = packet!;
    expect(buf.length).toBe(49);
    expect(readIvtp(buf)).toEqual({ type: 1, pktSize: 41, status: 0 });
    expect(buf.subarray(8, 16).toString('ascii')).toBe('IUSB    ');
    expect(buf.readUInt8(18)).toBe(32); // IUSB header size
    expect(buf.readInt32LE(20)).toBe(9); // 8 report bytes + the length byte
    expect(buf.readUInt8(25)).toBe(0x30); // device: keyboard
    expect(buf.readUInt8(26)).toBe(0x10); // protocol: keyboard
    expect(buf.readUInt8(27)).toBe(0x80);
    expect(buf.readUInt8(29)).toBe(0); // keyboard interface number
    expect(buf.readUInt8(40)).toBe(8); // report length
    expect(iusbChecksumIsValid(buf)).toBe(true);

    // Report: no modifiers, the auto-release flag set, scan code A = 4.
    expect(buf.readUInt8(41)).toBe(0);
    expect(buf.readUInt8(42)).toBe(1);
    expect(buf.readUInt8(43)).toBe(4);
  });

  it('increments the packet sequence number', () => {
    const kb = new KeyboardState();
    const first = kb.handle('KeyA', true)!;
    const second = kb.handle('KeyB', true)!;
    expect(first.readUInt32LE(32)).toBe(0);
    expect(second.readUInt32LE(32)).toBe(1);
  });

  it('sends no release for an ordinary key — the server releases it itself', () => {
    const kb = new KeyboardState();
    kb.handle('KeyA', true);
    expect(kb.handle('KeyA', false)).toBeNull();
  });

  it('sends an explicit release for lock keys', () => {
    const kb = new KeyboardState();
    kb.handle('CapsLock', true);
    const release = kb.handle('CapsLock', false);
    expect(release).not.toBeNull();
    expect(release!.readUInt8(42)).toBe(0); // no auto-release
    expect(release!.readUInt8(43)).toBe(0); // the slot is empty
  });

  it('accumulates and clears modifiers', () => {
    const kb = new KeyboardState();

    const ctrlDown = kb.handle('ControlLeft', true)!;
    expect(ctrlDown.readUInt8(41)).toBe(0x01);
    expect(ctrlDown.readUInt8(43)).toBe(0); // a modifier takes no key slot

    const altDown = kb.handle('AltLeft', true)!;
    expect(altDown.readUInt8(41)).toBe(0x05); // Ctrl + Alt

    // The key travels together with the active modifiers.
    const del = kb.handle('Delete', true)!;
    expect(del.readUInt8(41)).toBe(0x05);
    expect(del.readUInt8(43)).toBe(76);

    const ctrlUp = kb.handle('ControlLeft', false)!;
    expect(ctrlUp.readUInt8(41)).toBe(0x04); // Alt is still down
  });

  it('tells left and right modifiers apart', () => {
    const kb = new KeyboardState();
    expect(kb.handle('ShiftLeft', true)!.readUInt8(41)).toBe(0x02);
    kb.handle('ShiftLeft', false);
    expect(kb.handle('ShiftRight', true)!.readUInt8(41)).toBe(0x20);
  });

  it('ignores unknown keys', () => {
    const kb = new KeyboardState();
    expect(kb.handle('LaunchMediaPlayer', true)).toBeNull();
  });
});

describe('mouse', () => {
  it('builds an absolute packet scaled into 0..32767', () => {
    const mouse = new MouseState();
    const packet = mouse.absolute(369, 207, 1, 0, 738, 414);

    expect(packet.length).toBe(47);
    expect(readIvtp(packet)).toEqual({ type: 1, pktSize: 39, status: 0 });
    expect(packet.readInt32LE(20)).toBe(7); // 6 report bytes + the length byte
    expect(packet.readUInt8(25)).toBe(0x31); // device: mouse
    expect(packet.readUInt8(26)).toBe(0x20);
    expect(packet.readUInt8(29)).toBe(1); // mouse interface
    expect(packet.readUInt8(40)).toBe(6);
    expect(iusbChecksumIsValid(packet)).toBe(true);

    expect(packet.readUInt8(41)).toBe(1); // left button
    // The centre of the screen scales to roughly half the range.
    expect(packet.readInt16LE(42)).toBe(16384);
    expect(packet.readInt16LE(44)).toBe(16384);
  });

  it('clamps coordinates to the range boundaries', () => {
    const mouse = new MouseState();
    const topLeft = mouse.absolute(0, 0, 0, 0, 738, 414);
    expect(topLeft.readInt16LE(42)).toBe(0);
    expect(topLeft.readInt16LE(44)).toBe(0);

    const bottomRight = mouse.absolute(738, 414, 0, 0, 738, 414);
    expect(bottomRight.readInt16LE(42)).toBe(32767);
    expect(bottomRight.readInt16LE(44)).toBe(32767);

    // Going off screen must not overflow an int16.
    const beyond = mouse.absolute(10_000, 10_000, 0, 0, 738, 414);
    expect(beyond.readInt16LE(42)).toBe(32767);
  });

  it('builds a relative packet', () => {
    const mouse = new MouseState();
    const [packet] = mouse.relative(10, -5, 2, 0);

    expect(packet.length).toBe(45);
    expect(readIvtp(packet)).toEqual({ type: 1, pktSize: 37, status: 0 });
    expect(packet.readInt32LE(20)).toBe(5);
    expect(packet.readUInt8(40)).toBe(4);
    expect(iusbChecksumIsValid(packet)).toBe(true);

    expect(packet.readUInt8(41)).toBe(2); // right button
    expect(packet.readInt8(42)).toBe(10);
    expect(packet.readInt8(43)).toBe(-5);
  });

  it('splits a large relative delta across several packets', () => {
    const mouse = new MouseState();
    const packets = mouse.relative(300, 0, 0, 0);

    expect(packets.length).toBe(3);
    expect(packets[0].readInt8(42)).toBe(126);
    expect(packets[1].readInt8(42)).toBe(126);
    expect(packets[2].readInt8(42)).toBe(48);
    expect(packets.reduce((sum, p) => sum + p.readInt8(42), 0)).toBe(300);
  });

  it('normalises the wheel to a direction', () => {
    const mouse = new MouseState();
    expect(mouse.absolute(0, 0, 0, 5, 738, 414).readInt8(46)).toBe(1);
    expect(mouse.absolute(0, 0, 0, -5, 738, 414).readInt8(46)).toBe(-1);
    expect(mouse.absolute(0, 0, 0, 0, 738, 414).readInt8(46)).toBe(0);
  });

  it('keeps the cursor position when scrolling in absolute mode', () => {
    const mouse = new MouseState();
    mouse.absolute(369, 207, 0, 0, 738, 414);

    // The original JViewer sends (0,0) here and drags the cursor into a corner.
    const [wheel] = mouse.wheelOnly(1, 'absolute', 738, 414);
    expect(wheel.readInt16LE(42)).toBe(16384);
    expect(wheel.readInt16LE(44)).toBe(16384);
    expect(wheel.readInt8(46)).toBe(1);
  });
});
