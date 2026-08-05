/**
 * Decodes captured frames and writes PNGs next to them in .data/samples/.
 * Lets you check the decoder by eye.
 *
 * Run: npm run decode:frame -- [file.bin ...]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { AvicaDecoder, parseFrameHeader } from '../src/shared/avica';
import { encodePng } from './png';

const SAMPLE_DIR = '.data/samples';

function samples(): string[] {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;
  return readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith('.bin'))
    .sort()
    .map((f) => join(SAMPLE_DIR, f));
}

const decoder = new AvicaDecoder();

for (const path of samples()) {
  const frame = readFileSync(path);
  const header = parseFrameHeader(frame);
  console.log(
    `${basename(path)}: flags=${header.flags} frameSize=${header.frameSize} ` +
      `res=${header.resX}x${header.resY} act=${header.actResX}x${header.actResY}`,
  );

  try {
    const decoded = decoder.decode(frame);
    const out = path.replace(/\.bin$/, '.png');
    writeFileSync(out, encodePng(decoded.pixels, decoded.width, decoded.height));

    // A little statistics, to tell a black screen from a real picture.
    let nonBlack = 0;
    for (let i = 3; i < decoded.pixels.length; i += 4) {
      if (decoded.pixels[i - 3] || decoded.pixels[i - 2] || decoded.pixels[i - 1]) nonBlack++;
    }
    const total = decoded.width * decoded.height;
    console.log(
      `  -> ${out} (${decoded.width}x${decoded.height}, ` +
        `${nonBlack} non-empty pixels of ${total}, ${((nonBlack / total) * 100).toFixed(1)}%)`,
    );
  } catch (err) {
    console.error(`  DECODE ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
