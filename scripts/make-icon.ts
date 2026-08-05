/**
 * Generates the application icon (build/icon.png, 1024x1024).
 *
 * Drawn programmatically to keep a binary asset out of the repository and
 * avoid depending on an image editor. electron-builder derives the .icns and
 * .ico formats from this PNG itself.
 *
 * Run: npm run make:icon
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePng } from './png';

const SIZE = 1024;

/** The palette matches the dark theme of the interface. */
const BACKGROUND = [0x1c, 0x1f, 0x26];
const SCREEN = [0x0a, 0x0c, 0x10];
const ACCENT = [0x4a, 0x8c, 0xff];
const TEXT = [0xe6, 0xe9, 0xef];

const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);

function set(x: number, y: number, rgb: number[], alpha = 255): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  pixels[i] = rgb[0];
  pixels[i + 1] = rgb[1];
  pixels[i + 2] = rgb[2];
  pixels[i + 3] = alpha;
}

function fillRect(x0: number, y0: number, w: number, h: number, rgb: number[]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) set(x, y, rgb);
  }
}

/** Rectangle with rounded corners and an antialiased edge. */
function fillRoundRect(
  x0: number,
  y0: number,
  w: number,
  h: number,
  radius: number,
  rgb: number[],
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      // Distance to the nearest corner centre along each axis.
      const dx = Math.max(x0 + radius - x, 0, x - (x0 + w - 1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y0 + h - 1 - radius));
      const distance = Math.hypot(dx, dy);
      if (distance <= radius - 1) {
        set(x, y, rgb);
      } else if (distance < radius) {
        // Edge pixels are filled partially, so the outline is not ragged.
        set(x, y, rgb, Math.round((radius - distance) * 255));
      }
    }
  }
}

// Background tile.
fillRoundRect(0, 0, SIZE, SIZE, 180, BACKGROUND);

// Console screen.
const screenX = 150;
const screenY = 210;
const screenW = SIZE - screenX * 2;
const screenH = 470;
fillRoundRect(screenX, screenY, screenW, screenH, 28, SCREEN);

// Lines of "text" on the screen — a hint of console output.
const lineX = screenX + 60;
const lineH = 26;
const lineGap = 62;
const lineWidths = [520, 400, 610, 330];
for (let i = 0; i < lineWidths.length; i++) {
  const y = screenY + 90 + i * lineGap;
  fillRect(lineX, y, lineWidths[i], lineH, i === 0 ? ACCENT : TEXT);
}

// Cursor at the end of the last line.
fillRect(lineX + lineWidths[lineWidths.length - 1] + 24, screenY + 90 + 3 * lineGap, 34, lineH, ACCENT);

// Monitor stand.
const standW = 180;
fillRect((SIZE - standW) / 2, screenY + screenH, standW, 46, BACKGROUND.map((c) => c + 24));
fillRoundRect((SIZE - 360) / 2, screenY + screenH + 46, 360, 40, 20, ACCENT);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', encodePng(pixels, SIZE, SIZE));
console.log('Icon written: build/icon.png');
