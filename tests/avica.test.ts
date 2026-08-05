import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AvicaDecoder, DecodeError, parseFrameHeader } from '../src/shared/avica';

/**
 * The fixtures are real frames captured from a Supermicro BMC (an Intel Boot
 * Agent screen, 738x414 with actResX=800). Frame 001 is a full frame
 * (flags=2); 002 and 003 are delta frames in which the underscore cursor
 * blinks.
 *
 * One line of frame 001 — the one carrying the adapter's MAC address and GUID
 * — was redacted before publication: the literal tokens covering those rows
 * were rewritten to 0x8000 (explicit black). The byte length, the
 * fragmentation and the run structure are untouched, so the stream is still
 * exactly what the firmware emitted, and the property that matters most for
 * these tests — actResX != resX — is intact.
 */
const FIXTURES = join(__dirname, 'fixtures');

function loadFrame(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

function hashPixels(pixels: Uint8ClampedArray): string {
  const view = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length);
  return createHash('sha256').update(view).digest('hex').slice(0, 16);
}

function countNonBlack(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] || pixels[i + 1] || pixels[i + 2]) count++;
  }
  return count;
}

describe('parseFrameHeader', () => {
  it('parses the header of a real frame', () => {
    const header = parseFrameHeader(loadFrame('frame-001.bin'));
    expect(header).toEqual({
      flags: 2,
      frameSize: 20410,
      resX: 738,
      resY: 414,
      actResX: 800,
      actResY: 414,
    });
  });

  it('rejects a frame shorter than its header', () => {
    expect(() => parseFrameHeader(new Uint8Array(5))).toThrow(DecodeError);
  });
});

describe('AvicaDecoder', () => {
  it('decodes a full frame into a resX x resY raster', () => {
    const decoder = new AvicaDecoder();
    const decoded = decoder.decode(loadFrame('frame-001.bin'));

    expect(decoded.width).toBe(738);
    expect(decoded.height).toBe(414);
    expect(decoded.resolutionChanged).toBe(true);
    expect(decoded.pixels.length).toBe(738 * 414 * 4);
    // The Boot Agent screen: white text on black, about 2% of the pixels.
    expect(countNonBlack(decoded.pixels)).toBe(5971);
    expect(hashPixels(decoded.pixels)).toBe('02adb8174620870f');
  });

  it('applies delta frames on top of the previous state', () => {
    const decoder = new AvicaDecoder();
    decoder.decode(loadFrame('frame-001.bin'));

    // Frame 002 hides the cursor — 18 pixels disappear.
    const second = decoder.decode(loadFrame('frame-002.bin'));
    expect(second.resolutionChanged).toBe(false);
    expect(countNonBlack(second.pixels)).toBe(5953);
    expect(hashPixels(second.pixels)).toBe('f29b8ce1d102082a');

    // Frame 003 brings the cursor back — the picture matches the first again.
    const third = decoder.decode(loadFrame('frame-003.bin'));
    expect(countNonBlack(third.pixels)).toBe(5971);
    expect(hashPixels(third.pixels)).toBe('02adb8174620870f');
  });

  it('survives replaying the same sequence', () => {
    const decoder = new AvicaDecoder();
    for (let i = 0; i < 3; i++) {
      decoder.decode(loadFrame('frame-001.bin'));
      decoder.decode(loadFrame('frame-002.bin'));
      decoder.decode(loadFrame('frame-003.bin'));
    }
    const final = decoder.decode(loadFrame('frame-001.bin'));
    expect(hashPixels(final.pixels)).toBe('02adb8174620870f');
  });

  it('rejects a frame with an invalid resolution', () => {
    const frame = Buffer.from(loadFrame('frame-001.bin'));
    frame.writeInt16LE(100, 5); // resX below the minimum
    expect(() => new AvicaDecoder().decode(frame)).toThrow(/resolution/);
  });

  it('rejects a frame whose frameSize exceeds the frame itself', () => {
    const frame = Buffer.from(loadFrame('frame-001.bin'));
    frame.writeInt32LE(999_999, 1);
    expect(() => new AvicaDecoder().decode(frame)).toThrow(/does not fit/);
  });

  it('demands a full frame after an error', () => {
    const decoder = new AvicaDecoder();
    decoder.decode(loadFrame('frame-001.bin'));
    expect(decoder.needsFullScreen).toBe(false);

    const broken = Buffer.from(loadFrame('frame-002.bin'));
    broken.writeInt32LE(999_999, 1);
    expect(() => decoder.decode(broken)).toThrow(DecodeError);
    expect(decoder.needsFullScreen).toBe(true);
  });
});
