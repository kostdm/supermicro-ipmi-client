/**
 * Checks Virtual Media against a live BMC: mounts an ISO, reboots the server
 * and shows which SCSI commands the BIOS issues.
 *
 * WARNING: performs a hard reset of the server. Lab hardware only.
 *
 * Run: npm run check:vmedia -- <path to .iso> <host> [user] [password]
 */
import { connect, logout } from '../src/main/bmc/auth';
import { KvmSession } from '../src/main/kvm/session';
import { Pkt, buildControl } from '../src/main/kvm/ivtp';
import { VirtualMediaSession } from '../src/main/vm/session';
import { CD_SECTOR_SIZE } from '../src/main/vm/scsi';
import { fail, parseTarget } from './args';

const isoPath = process.argv[2];

if (!isoPath) {
  console.error('Usage: npm run check:vmedia -- <path to .iso> <host> [user] [password]');
  process.exit(2);
}

const { host, user, password } = parseTarget('check:vmedia', '<path to .iso> ', 1);

/** Human-readable names for the commands the BIOS issues. */
const SCSI_NAMES: Record<number, string> = {
  0x00: 'TEST UNIT READY',
  0x03: 'REQUEST SENSE',
  0x12: 'INQUIRY',
  0x1a: 'MODE SENSE(6)',
  0x1b: 'START STOP UNIT',
  0x1e: 'PREVENT ALLOW MEDIUM REMOVAL',
  0x23: 'READ FORMAT CAPACITIES',
  0x25: 'READ CAPACITY(10)',
  0x28: 'READ(10)',
  0x2b: 'SEEK(10)',
  0x35: 'SYNCHRONIZE CACHE',
  0x43: 'READ TOC',
  0x46: 'GET CONFIGURATION',
  0x4a: 'GET EVENT STATUS NOTIFICATION',
  0x51: 'READ DISC INFORMATION',
  0x5a: 'MODE SENSE(10)',
  0xa8: 'READ(12)',
  0xbb: 'SET CD SPEED',
};

async function main() {
  const { session: web, credentials } = await connect(host, user, password);
  console.log(`Connecting to ${host}, CD-ROM port ${credentials.cdPort}`);

  const kvm = new KvmSession(credentials);
  // The BMC sends the current service ports in a separate packet: in the JNLP
  // the CD-ROM port is replaced with 0x7FFFFFFE while the slot is taken.
  let cdPort = credentials.cdPort;
  kvm.on('services', (services) => {
    console.log('BMC services:');
    for (const s of services) {
      console.log(
        `  ${(s.name || '(unnamed)').padEnd(12)} port ${String(s.port).padEnd(6)}` +
          `${s.enabled ? '' : ' — unavailable'}`,
      );
    }
    const cd = services.find((s) => s.name.toLowerCase().startsWith('cd'));
    if (cd && cd.port > 0 && cd.port < 65536) cdPort = cd.port;
  });

  await new Promise<void>((resolve, reject) => {
    kvm.once('authenticated', resolve);
    kvm.once('error', reject);
    kvm.connect();
    setTimeout(() => reject(new Error('KVM session did not come up')), 20_000);
  });
  console.log('KVM session established');

  // The service configuration packet arrives shortly after authentication.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (cdPort <= 0 || cdPort >= 65536) cdPort = 5120;
  console.log(`Using CD-ROM port: ${cdPort}`);

  // VM_KIND selects the mode: cdrom (port 5120) or harddisk (5123).
  const kind = process.env.VM_KIND === 'harddisk' ? 'harddisk' : 'cdrom';
  const port = kind === 'harddisk' ? 5123 : cdPort;
  console.log(`Mode: ${kind}, port ${port}`);

  const vm = new VirtualMediaSession({
    host,
    port,
    token: credentials.kvmToken,
    isoPath,
    kind,
  });

  // Counting the incoming commands shows whether the BIOS saw the device.
  const seen = new Map<number, number>();

  await new Promise<void>((resolve, reject) => {
    vm.once('ready', resolve);
    vm.once('error', reject);
    vm.once('closed', (reason) => reject(new Error(reason)));
    vm.connect();
    setTimeout(() => reject(new Error('Virtual Media did not confirm the connection')), 15_000);
  });

  console.log(`Image mounted: ${isoPath}`);
  kvm.send(buildControl(Pkt.MEDIA_STATE, 1));
  console.log('Sent MEDIA_STATE=1');

  const verbose = process.env.VM_DEBUG === '1';
  const hex = (buf: Buffer) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

  // Intercept the commands through the session internals.
  const target = vm as unknown as {
    handlePacket: (p: { cdb: Buffer; payload: Buffer }) => void;
    socket: { write: (b: Buffer) => void } | null;
  };
  const original = target.handlePacket.bind(vm);
  target.handlePacket = (packet) => {
    const opcode = packet.cdb?.[0];
    if (opcode !== undefined) {
      const count = (seen.get(opcode) ?? 0) + 1;
      seen.set(opcode, count);
      if (count === 1) {
        console.log(
          `  <- ${SCSI_NAMES[opcode] ?? 'unknown command'} ` +
            `(0x${opcode.toString(16).padStart(2, '0')})`,
        );
      }
      if (verbose && count <= 2) {
        console.log(`     request  payload[0..29]: ${hex(packet.payload.subarray(0, 30))}`);
        // Intercept the reply the session is about to send.
        const socket = target.socket;
        if (socket) {
          const write = socket.write.bind(socket);
          socket.write = (buf: Buffer) => {
            console.log(`     reply    header:        ${hex(buf.subarray(0, 32))}`);
            console.log(`     reply    payload[0..29]:${hex(buf.subarray(32, 62))}`);
            console.log(`     reply    data (${buf.length - 62} B): ${hex(buf.subarray(62, 78))}`);
            socket.write = write;
            return write(buf);
          };
        }
      }
    }
    original(packet);
  };

  vm.on('progress', (bytes) => {
    if (bytes % (1024 * 1024) < CD_SECTOR_SIZE * 64) {
      console.log(`  read ${(bytes / 1024 / 1024).toFixed(1)} MB of the image`);
    }
  });

  console.log('\nRebooting the server (hard reset)…');
  kvm.sendPowerCommand('hard-reset');

  console.log('Waiting for the BIOS to talk to the virtual drive…\n');
  await new Promise((resolve) => setTimeout(resolve, 90_000));

  console.log('\n=== Summary ===');
  if (seen.size === 0) {
    console.log('The BIOS never touched the virtual drive.');
    process.exitCode = 1;
  } else {
    for (const [opcode, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  ${(SCSI_NAMES[opcode] ?? 'unknown').padEnd(32)} ` +
          `0x${opcode.toString(16).padStart(2, '0')}  ${count}x`,
      );
    }
    console.log(`\nServed to the server: ${(vm.servedBytes / 1024 / 1024).toFixed(2)} MB`);
  }

  vm.close();
  kvm.close();
  await logout(web);
}

main().catch(fail);
