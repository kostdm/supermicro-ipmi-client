/**
 * Virtual Media debugging harness.
 *
 * Connects to one of the media services (cd/fd/hd), serves an ISO through the
 * real IsoScsiTarget and logs every request and reply in full. Unlike
 * check-vmedia it does not reboot the server: point it at a machine that is
 * already sitting in the BIOS boot menu, or reboot by hand.
 *
 * Run: npm run vm:debug -- <path to .iso> <host> [user] [password]
 * Env: VM_KIND=cdrom|floppy|harddisk (default harddisk), VM_PORT=<port>,
 *      VM_RESET=1 to hard-reset the server after mounting.
 */
import net from 'node:net';
import { connect, logout, type BmcSession } from '../src/main/bmc/auth';
import { KvmSession } from '../src/main/kvm/session';
import { Pkt, buildControl } from '../src/main/kvm/ivtp';
import {
  DeviceType,
  IUSB_HEADER_SIZE,
  IusbOpcode,
  buildAuthPacket,
  buildScsiResponse,
  parseAuthAck,
  parseIusbPacket,
} from '../src/main/vm/iusb';
import { IsoScsiTarget } from '../src/main/vm/scsi';
import { fail, parseTarget } from './args';

const isoPath = process.argv[2];
if (!isoPath) {
  console.error('Usage: npm run vm:debug -- <path to .iso> <host> [user] [password]');
  process.exit(2);
}
const { host, user, password } = parseTarget('vm:debug', '<path to .iso> ', 1);

const SCSI_NAMES: Record<number, string> = {
  0x00: 'TEST UNIT READY',
  0x03: 'REQUEST SENSE',
  0x12: 'INQUIRY',
  0x15: 'MODE SELECT(6)',
  0x1a: 'MODE SENSE(6)',
  0x1b: 'START STOP UNIT',
  0x1e: 'PREVENT ALLOW MEDIUM REMOVAL',
  0x23: 'READ FORMAT CAPACITIES',
  0x25: 'READ CAPACITY(10)',
  0x28: 'READ(10)',
  0x2a: 'WRITE(10)',
  0x2b: 'SEEK(10)',
  0x35: 'SYNCHRONIZE CACHE',
  0x43: 'READ TOC',
  0x46: 'GET CONFIGURATION',
  0x4a: 'GET EVENT STATUS NOTIFICATION',
  0x51: 'READ DISC INFORMATION',
  0x5a: 'MODE SENSE(10)',
  0x9e: 'SERVICE ACTION IN(16)',
  0xa8: 'READ(12)',
  0xad: 'READ DVD STRUCTURE',
  0xbb: 'SET CD SPEED',
};

const hex = (buf: Buffer) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

const kindArg = (process.env.VM_KIND ?? 'harddisk') as 'cdrom' | 'floppy' | 'harddisk';
const deviceType =
  kindArg === 'harddisk'
    ? DeviceType.HARDDISK
    : kindArg === 'floppy'
      ? DeviceType.FLOPPY
      : DeviceType.CDROM;

async function main() {
  const { session: web, credentials } = await connect(host, user, password);
  console.log(`token=${credentials.kvmToken}`);
  console.log(
    `jnlp ports: cd=${credentials.cdPort} fd=${credentials.fdPort} hd=${credentials.hdPort}`,
  );

  const kvm = new KvmSession(credentials);
  let services: { name: string; port: number; enabled: boolean }[] = [];
  kvm.on('services', (s) => {
    services = s;
    console.log('services:', s.map((x) => `${x.name || '(none)'}:${x.port}`).join(' '));
  });

  await new Promise<void>((resolve, reject) => {
    kvm.once('authenticated', resolve);
    kvm.once('error', reject);
    kvm.connect();
    setTimeout(() => reject(new Error('KVM session did not come up')), 20_000);
  });
  console.log('KVM up');
  await new Promise((r) => setTimeout(r, 2500));

  const byName = (prefix: string) =>
    services.find((s) => s.name.toLowerCase().startsWith(prefix))?.port ?? 0;
  const port =
    Number(process.env.VM_PORT) ||
    (kindArg === 'harddisk' ? byName('hd') : kindArg === 'floppy' ? byName('fd') : byName('cd')) ||
    (kindArg === 'harddisk' ? 5123 : kindArg === 'floppy' ? 5122 : 5120);

  console.log(`mode=${kindArg} deviceType=${deviceType} port=${port}`);

  const target = new IsoScsiTarget(isoPath, kindArg === 'cdrom' ? 'cdrom' : 'harddisk');
  target.open();
  console.log(`image ${isoPath}: ${target.sectors} sectors`);

  const socket = net.connect(port, host);
  let rx = Buffer.alloc(0);
  let n = 0;
  let served = 0;
  const seen = new Map<number, number>();

  const finish = async (reason: string) => {
    console.log(`\n== ${reason} ==`);
    console.log('command histogram:');
    for (const [op, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  0x${op.toString(16).padStart(2, '0')} ${(SCSI_NAMES[op] ?? '?').padEnd(30)} ${count}x`,
      );
    }
    console.log(`served ${(served / 1024 / 1024).toFixed(2)} MB`);
    socket.destroy();
    kvm.close();
    await logout(web as BmcSession);
    process.exit(0);
  };

  socket.on('connect', () => {
    console.log('TCP connected, AUTH');
    socket.write(buildAuthPacket(credentials.kvmToken, 0, deviceType));
  });

  socket.on('data', (chunk) => {
    rx = rx.length === 0 ? chunk : Buffer.concat([rx, chunk]);

    while (rx.length >= IUSB_HEADER_SIZE) {
      const dataLen = rx.readUInt32LE(12);
      const total = IUSB_HEADER_SIZE + dataLen;
      if (rx.length < total) return;
      const raw = rx.subarray(0, total);
      rx = rx.subarray(total);

      const packet = parseIusbPacket(raw);
      if (!packet) {
        console.log('BAD PACKET', hex(raw.subarray(0, 64)));
        void finish('protocol error');
        return;
      }

      if (packet.opcode === IusbOpcode.REDIRECTION_ACK) {
        const ack = parseAuthAck(packet);
        console.log(`ACK accepted=${ack.accepted} otherIp=${ack.otherIp}`);
        console.log(`  header  : ${hex(raw.subarray(0, 32))}`);
        console.log(`  payload : ${hex(packet.payload.subarray(0, 40))}`);
        if (!ack.accepted) {
          void finish('refused');
          return;
        }
        kvm.send(buildControl(Pkt.MEDIA_STATE, 1));
        console.log('MEDIA_STATE=1 sent, waiting for SCSI…');
        if (process.env.VM_RESET === '1') {
          setTimeout(() => {
            console.log('hard reset');
            kvm.sendPowerCommand('hard-reset');
          }, 1000);
        }
        continue;
      }

      n++;
      const op = packet.cdb[0];
      seen.set(op, (seen.get(op) ?? 0) + 1);

      const result = target.execute(packet.cdb);
      const reply = buildScsiResponse(packet, result);
      served += result.data.length;

      const quiet = process.env.VM_QUIET === '1' && (seen.get(op) ?? 0) > 3;
      if (!quiet) {
        console.log(
          `\n#${n} ${SCSI_NAMES[op] ?? '?'} (0x${op.toString(16).padStart(2, '0')}) ` +
            `seq=${packet.header.sequenceNumber} dev=${packet.header.deviceNumber} ` +
            `iface=${packet.header.interfaceNumber} clientData=${packet.header.clientData} ` +
            `inst=${packet.header.instance} dir=0x${packet.header.direction.toString(16)} ` +
            `devType=${packet.header.deviceType} len=${packet.header.dataPacketLen}`,
        );
        console.log(`  req hdr  : ${hex(raw.subarray(0, 32))}`);
        console.log(`  req [0:9]: ${hex(packet.payload.subarray(0, 9))}`);
        console.log(`  req cdb  : ${hex(packet.payload.subarray(9, 25))}`);
        console.log(`  req [25:] : ${hex(packet.payload.subarray(25, 30))}`);
        if (packet.payload.length > 30) {
          console.log(`  req data : ${packet.payload.length - 30} B`);
        }
        console.log(
          `  -> status=${result.status} data=${result.data.length} ` +
            `sense=${result.sense ? `${result.sense.key}/${result.sense.asc}/${result.sense.ascq}` : 'none'}`,
        );
        console.log(`  rsp hdr  : ${hex(reply.subarray(0, 32))}`);
        console.log(`  rsp pay  : ${hex(reply.subarray(32, 62))}`);
        if (reply.length > 62) console.log(`  rsp data : ${hex(reply.subarray(62, 94))}…`);
      }

      socket.write(reply);
    }
  });

  socket.on('error', (err) => void finish(`socket error: ${err.message}`));
  socket.on('close', () => void finish('closed by BMC'));

  setTimeout(() => void finish('timeout'), Number(process.env.VM_TIME ?? 60) * 1000);
}

main().catch(fail);
