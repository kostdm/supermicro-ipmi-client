/**
 * Checks a KVM session against a live BMC: handshake and video frames.
 * Captured frames are written to .data/samples/ for the decoder tests.
 *
 * Run: npm run check:kvm -- <host> [user] [password]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, logout } from '../src/main/bmc/auth';
import { KvmSession } from '../src/main/kvm/session';
import { fail, parseTarget } from './args';

const { host, user, password } = parseTarget('check:kvm');
const SAMPLE_DIR = '.data/samples';
const FRAMES_TO_COLLECT = 12;

function describeFrame(frame: Buffer, index: number): void {
  const flags = frame.readUInt8(0);
  const frameSize = frame.readInt32LE(1);
  const resX = frame.readInt16LE(5);
  const resY = frame.readInt16LE(7);
  const actResX = frame.readInt16LE(9);
  const actResY = frame.readInt16LE(11);
  console.log(
    `  frame #${index}: ${frame.length} bytes | flags=${flags} frameSize=${frameSize} ` +
      `res=${resX}x${resY} act=${actResX}x${actResY}`,
  );
}

async function main() {
  console.log(`Logging in to ${host}...`);
  const { session: web, credentials } = await connect(host, user, password);
  console.log(`  kvmToken=${credentials.kvmToken}, port ${credentials.kvmPort}`);

  const kvm = new KvmSession(credentials);
  let frames = 0;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out: no frames received')), 25_000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };

    kvm.on('connected', () => console.log('TCP connected, waiting for SESSION_ACCEPTED...'));
    kvm.on('authenticated', () => console.log('KVM authentication passed'));
    kvm.on('mouseMode', (mode) => console.log(`  mouse mode: ${mode}`));
    kvm.on('powerStatus', (on) => console.log(`  power: ${on ? 'on' : 'off'}`));
    kvm.on('keyboardLeds', (leds) => console.log(`  keyboard LEDs: 0b${leds.toString(2)}`));
    kvm.on('blankScreen', () => console.log('  no video signal'));
    kvm.on('activeClients', (list) => console.log(`  active clients: ${list.join(', ')}`));

    kvm.on('frame', (frame) => {
      frames++;
      describeFrame(frame, frames);
      mkdirSync(SAMPLE_DIR, { recursive: true });
      // Zero-padded so the files decode in arrival order.
      const name = `frame-${String(frames).padStart(3, '0')}.bin`;
      writeFileSync(`${SAMPLE_DIR}/${name}`, frame);
      if (frames >= FRAMES_TO_COLLECT) finish();
    });

    kvm.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    kvm.on('closed', (reason) => {
      clearTimeout(timer);
      if (frames > 0) resolve();
      else reject(new Error(reason));
    });
  });

  kvm.connect();
  try {
    await done;
    console.log(`\nSuccess: received ${frames} frames`);
  } finally {
    kvm.close();
    await logout(web);
  }
}

main().catch(fail);
