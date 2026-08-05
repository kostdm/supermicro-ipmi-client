/**
 * Checks key delivery: reboots the server and hammers one key during POST
 * while saving screen frames as PNG.
 *
 * The frames show whether the BIOS reacted — whether the boot menu opened,
 * for instance.
 *
 * WARNING: performs a hard reset of the server. Lab hardware only.
 *
 * Run: npm run check:hotkey -- <key> <host> [user] [password]
 *   npm run check:hotkey -- F12 10.0.0.5
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, logout } from '../src/main/bmc/auth';
import { KvmSession } from '../src/main/kvm/session';
import { KeyboardState } from '../src/main/kvm/hid';
import { AvicaDecoder } from '../src/shared/avica';
import { encodePng } from './png';
import { fail, parseTarget } from './args';

const key = process.argv[2];

if (!key) {
  console.error('Usage: npm run check:hotkey -- <key> <host> [user] [password]');
  process.exit(2);
}

const { host, user, password } = parseTarget('check:hotkey', '<key> ', 1);

const OUT_DIR = '.data/hotkey';
/** How long to keep sending the key after the reset: POST takes about a minute. */
const DURATION_MS = 150_000;
/** The BIOS only catches a key inside a narrow window, so press often. */
const KEY_INTERVAL_MS = 250;
/** Frames are saved less often so the disk does not fill up. */
const SNAPSHOT_INTERVAL_MS = 10_000;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const { session: web, credentials } = await connect(host, user, password);
  const kvm = new KvmSession(credentials);
  const keyboard = new KeyboardState();
  const decoder = new AvicaDecoder();

  let frames = 0;
  let snapshots = 0;
  let lastSnapshot = 0;
  let lastDecoded: { width: number; height: number; pixels: Uint8ClampedArray } | null = null;

  kvm.on('frame', (frame) => {
    frames++;
    try {
      const decoded = decoder.decode(frame);
      lastDecoded = {
        width: decoded.width,
        height: decoded.height,
        // The decoder reuses its buffer — take a copy.
        pixels: new Uint8ClampedArray(decoded.pixels),
      };
    } catch {
      kvm.requestFullScreen();
    }
  });

  await new Promise<void>((resolve, reject) => {
    kvm.once('authenticated', resolve);
    kvm.once('error', reject);
    kvm.connect();
    setTimeout(() => reject(new Error('KVM session did not come up')), 20_000);
  });
  console.log('KVM session established');

  const usage = keyboard.handle(key, true);
  if (!usage) {
    console.error(`Key ${key} is not in the key map`);
    process.exit(1);
  }
  console.log(`Key ${key} recognised, scan code 0x${usage.readUInt8(43).toString(16)}`);

  console.log('Rebooting the server…');
  kvm.sendPowerCommand('hard-reset');

  const started = Date.now();
  let presses = 0;

  const timer = setInterval(() => {
    const packet = keyboard.handle(key, true);
    if (packet) {
      kvm.send(packet);
      presses++;
    }

    const now = Date.now();
    if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS && lastDecoded) {
      lastSnapshot = now;
      snapshots++;
      const seconds = Math.round((now - started) / 1000);
      const name = `${OUT_DIR}/t${String(seconds).padStart(3, '0')}s.png`;
      writeFileSync(name, encodePng(lastDecoded.pixels, lastDecoded.width, lastDecoded.height));
      console.log(`  ${seconds}s: ${frames} frames, ${presses} presses -> ${name}`);
    }
  }, KEY_INTERVAL_MS);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  clearInterval(timer);

  // A final frame once everything has settled.
  if (lastDecoded) {
    writeFileSync(
      `${OUT_DIR}/final.png`,
      encodePng(lastDecoded.pixels, lastDecoded.width, lastDecoded.height),
    );
  }

  console.log(`\nSummary: ${frames} frames, ${presses} presses, ${snapshots} snapshots`);
  console.log(`See ${OUT_DIR}/`);

  kvm.close();
  await logout(web);
}

main().catch(fail);
