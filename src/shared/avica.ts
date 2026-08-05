import type { FrameHeader } from './types';

/**
 * Decoder for the AVICA2A video codec (AMI SOC).
 *
 * A port of JViewer's AVICA2AU.java and the SOCJVVideo.java glue around it.
 * Pure computation, no DOM — used both in a Web Worker and in Node tests.
 *
 * Frame format: a 13-byte header, then exactly frameSize bytes of a stream of
 * 16-bit tokens. Pixels are RGB555.
 *
 * One deliberate difference from the original: the index into the output
 * raster is always computed by the absolute formula y*resX + (actResX-1-x).
 * The Java per-pixel path increments instead (`pD32--`, and `pD32 +=
 * 2*actResX` at a line break), which is only equivalent when
 * actResX === resX. On a real BMC it is not (actResX=800 with resX=738, for
 * instance), and the original produces drifting rows until the next long run
 * recomputes the index.
 */

/** Frame header size. */
export const FRAME_HEADER_SIZE = 13;

/** Largest resolution the decoder's screen buffers hold (1800x1800). */
const MAX_RES = 1800;
const SCREEN_LEN = MAX_RES * MAX_RES;

/**
 * Screen buffers are addressed from this offset: a row of zeroes before the
 * first row of the frame lets the "north" predictor on row 0 read zeroes
 * instead of running off the array.
 */
const SCREEN_BASE = MAX_RES;

/**
 * Pixel comparison threshold. It is never carried in the stream and is always
 * 1, so comparing channels degenerates into strict equality of values.
 */
const THRESHOLD = 1;

/** Flags in the frame header. */
const FLAG_ODD_FRAME = 1;
const FLAG_CLEAR_BUFFER = 2;

/** Resolution bounds outside which a frame counts as corrupt (as in JVVideo.java). */
const MIN_X = 300;
const MAX_X = 1920;
const MIN_Y = 200;
const MAX_Y = 1200;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export interface DecodedFrame {
  width: number;
  height: number;
  /** true when the resolution changed and the raster was recreated. */
  resolutionChanged: boolean;
  /**
   * RGBA pixels of the current frame. The buffer is reused between calls —
   * copy it if you need to keep it.
   */
  pixels: Uint8ClampedArray;
}

/** Parses the 13-byte frame header. */
export function parseFrameHeader(frame: Uint8Array): FrameHeader {
  if (frame.length < FRAME_HEADER_SIZE) {
    throw new DecodeError(`frame shorter than its header: ${frame.length} bytes`);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    flags: view.getUint8(0),
    frameSize: view.getInt32(1, true),
    resX: view.getInt16(5, true),
    resY: view.getInt16(7, true),
    actResX: view.getInt16(9, true),
    actResY: view.getInt16(11, true),
  };
}

/** RGB555 -> packed RGBA (little-endian) table. Built once. */
const RGBA_LUT = buildRgbaLut();

function buildRgbaLut(): Uint32Array {
  const lut = new Uint32Array(0x8000);
  for (let v = 0; v < 0x8000; v++) {
    const r5 = (v >> 10) & 0x1f;
    const g5 = (v >> 5) & 0x1f;
    const b5 = v & 0x1f;
    // 5 -> 8 bit expansion by replicating the high bits.
    const r = (r5 << 3) | (r5 >> 2);
    const g = (g5 << 3) | (g5 >> 2);
    const b = (b5 << 3) | (b5 >> 2);
    lut[v] = (0xff << 24) | (b << 16) | (g << 8) | r;
  }
  return lut;
}

export class AvicaDecoder {
  /** Two screen buffers: one is written, the previous frame is read from the other. */
  private readonly screens: [Uint16Array, Uint16Array] = [
    new Uint16Array(SCREEN_LEN),
    new Uint16Array(SCREEN_LEN),
  ];

  /** The visible image in RGB555. It outlives frames and is patched in place. */
  private raster = new Uint16Array(0);

  private rgba = new Uint8ClampedArray(0);
  private rgbaWords = new Uint32Array(0);

  private width = 0;
  private height = 0;

  /** Buffer indices: [previous, current]. */
  private prevIndex = 0;
  private curIndex = 1;

  /**
   * While true, frames decode into the same buffers without the parity swap.
   * Cleared by the first frame carrying CLEAR_BUFFER, raised again on error.
   */
  private needFullScreen = true;

  /** Whether the caller should ask the BMC for a full frame. */
  get needsFullScreen(): boolean {
    return this.needFullScreen;
  }

  /** Marks the state as corrupt — the next frame has to be a full one. */
  markCorrupted(): void {
    this.needFullScreen = true;
  }

  /**
   * Decodes a whole frame (header + data) and returns RGBA pixels. Throws
   * DecodeError on a corrupt frame; the caller should then ask the BMC for a
   * full frame (GET_FULL_SCREEN).
   */
  decode(frame: Uint8Array): DecodedFrame {
    try {
      return this.decodeChecked(frame);
    } catch (err) {
      // Any error means the buffers no longer match the server's screen: a
      // full frame is needed next.
      this.needFullScreen = true;
      throw err instanceof DecodeError ? err : new DecodeError(String(err));
    }
  }

  private decodeChecked(frame: Uint8Array): DecodedFrame {
    const header = parseFrameHeader(frame);

    if (
      header.resX < MIN_X ||
      header.resX > MAX_X ||
      header.resY < MIN_Y ||
      header.resY > MAX_Y
    ) {
      throw new DecodeError(`invalid resolution ${header.resX}x${header.resY}`);
    }
    if (header.actResX <= 0 || header.actResX > MAX_RES || header.actResY <= 0) {
      throw new DecodeError(`invalid actRes ${header.actResX}x${header.actResY}`);
    }
    if (header.frameSize < 0 || FRAME_HEADER_SIZE + header.frameSize > frame.length) {
      throw new DecodeError(
        `frameSize=${header.frameSize} does not fit into a ${frame.length}-byte frame`,
      );
    }
    if (header.frameSize % 2 !== 0) {
      throw new DecodeError(`frameSize=${header.frameSize} is not a multiple of the token size`);
    }

    const resolutionChanged = this.width !== header.resX || this.height !== header.resY;
    if (resolutionChanged) this.resize(header.resX, header.resY);

    if (header.flags & FLAG_CLEAR_BUFFER) {
      this.screens[0].fill(0);
      this.screens[1].fill(0);
      this.raster.fill(0);
      this.needFullScreen = false;
    }

    if (!this.needFullScreen) {
      // Frame parity decides which buffer is current and which is previous.
      if ((header.flags & FLAG_ODD_FRAME) === 0) {
        this.prevIndex = 1;
        this.curIndex = 0;
      } else {
        this.prevIndex = 0;
        this.curIndex = 1;
      }
    }

    this.decodeStream(frame, header);

    this.rasterToRgba();
    return {
      width: this.width,
      height: this.height,
      resolutionChanged,
      pixels: this.rgba,
    };
  }

  private resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.raster = new Uint16Array(width * height);
    this.rgba = new Uint8ClampedArray(width * height * 4);
    this.rgbaWords = new Uint32Array(this.rgba.buffer);
  }

  /** The main loop: a stream of 16-bit tokens starting at offset 13. */
  private decodeStream(frame: Uint8Array, header: FrameHeader): void {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const prev = this.screens[this.prevIndex];
    const cur = this.screens[this.curIndex];
    const raster = this.raster;

    const X = header.actResX;
    const W = this.width;
    const rasterLen = raster.length;
    const frameSize = header.frameSize;

    // Predictors: the same pixel in the previous frame (a1), the pixel to the
    // left (a2) and the one up-left (c2) in the current frame.
    let a1 = 0;
    let a2 = 0;
    let c2 = 0;

    let pPrev = SCREEN_BASE; // index into the previous frame
    let pCur = SCREEN_BASE; // index into the current frame
    let pUp = SCREEN_BASE - X; // index one row up in the current frame
    let pOut = X - 1; // index into the raster (the image is mirrored on X)

    let x = 0;
    let y = 0;
    let compIx = 0;

    /** Writes a pixel into the current frame and, if visible, into the raster. */
    const put = (value: number) => {
      if (pCur < 0 || pCur >= SCREEN_LEN) {
        throw new DecodeError('screen buffer index out of bounds');
      }
      cur[pCur] = value;
      // Columns x < actResX-resX fall outside the visible area: their index
      // runs past the right edge of the row. The original loses them too.
      if (pOut >= 0 && pOut < rasterLen) raster[pOut] = value;
    };

    /** Advances one pixel, refreshing the predictors. */
    const step = () => {
      a1 = prev[pPrev];
      a2 = cur[pCur];
      c2 = pUp >= 0 ? cur[pUp] : 0;
      pPrev++;
      pCur++;
      pUp++;
      x++;
      if (x === X) {
        x = 0;
        y++;
        // On a new row there are no predictors yet.
        a1 = 0;
        a2 = 0;
        c2 = 0;
      }
      pOut = y * W + (X - 1 - x);
    };

    while (compIx !== frameSize) {
      if (compIx > frameSize - 2) {
        throw new DecodeError('stream ended in the middle of a token');
      }
      const token = view.getUint16(FRAME_HEADER_SIZE + compIx, true);
      compIx += 2;

      // A literal pixel: either the token value or an explicit black.
      if (token <= 0x8000) {
        put(token === 0x8000 ? 0 : token);
        step();
        continue;
      }

      let run: number;
      if (token >= 0xc000) {
        if (compIx > frameSize - 2) {
          throw new DecodeError('stream ended inside a long run counter');
        }
        run = ((token & 0x3fff) << 16) + view.getUint16(FRAME_HEADER_SIZE + compIx, true);
        compIx += 2;
      } else {
        run = token - 0x8000;
      }

      while (run !== 0) {
        if (a1 === a2) {
          // The pixel matches the previous frame — the rest of the run is
          // copied as a block. The raster already holds the right values.
          if (pPrev + run > SCREEN_LEN || pCur + run > SCREEN_LEN) {
            throw new DecodeError('block copy runs past the end of the buffer');
          }
          cur.set(prev.subarray(pPrev, pPrev + run), pCur);

          pCur += run;
          pPrev += run;
          pUp += run;

          y += Math.floor((x + run) / X);
          x = (x + run) % X;
          pOut = y * W + (X - 1 - x);

          a1 = prev[pPrev - 1];
          a2 = cur[pCur - 1];
          c2 = pUp - 1 >= 0 ? cur[pUp - 1] : 0;
          if (x === 0) {
            a1 = 0;
            a2 = 0;
            c2 = 0;
          }
          break;
        }

        // Spatial prediction: when the left pixel matches the up-left one,
        // take the pixel above, otherwise take the left one.
        const north = pUp >= 0 ? cur[pUp] : 0;
        const predicted = pixelsEqual(a2, c2) ? (pixelsEqual(north, c2) ? a2 : north) : a2;

        put(predicted);
        step();
        run--;
      }
    }
  }

  /** Converts the whole raster from RGB555 to RGBA. */
  private rasterToRgba(): void {
    const raster = this.raster;
    const words = this.rgbaWords;
    for (let i = 0; i < raster.length; i++) {
      words[i] = RGBA_LUT[raster[i] & 0x7fff];
    }
  }
}

/**
 * Compares two RGB555 pixels with THRESHOLD applied per channel. At
 * THRESHOLD === 1 — the only value a BMC ever sends — this is strict
 * equality, so take the short path.
 */
function pixelsEqual(a: number, b: number): boolean {
  if (THRESHOLD === 1) return a === b;
  const dr = Math.abs(((a >> 10) & 0x1f) - ((b >> 10) & 0x1f));
  const dg = Math.abs(((a >> 5) & 0x1f) - ((b >> 5) & 0x1f));
  const db = Math.abs((a & 0x1f) - (b & 0x1f));
  return dr < THRESHOLD && dg < THRESHOLD && db < THRESHOLD;
}
