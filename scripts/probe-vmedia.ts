/**
 * Virtual Media protocol reconnaissance: connects to the CD-ROM port,
 * authenticates and hex-dumps everything the BMC sends.
 *
 * Needed because the SCSI layer in the original JViewer lives in a native
 * library, so the layout of the housekeeping fields cannot be recovered from
 * the decompiled code — only a real exchange shows it.
 *
 * Run: npm run probe:vmedia -- <host> [user] [password]
 */
import net from 'node:net';
import { connect, logout } from '../src/main/bmc/auth';
import { KvmSession } from '../src/main/kvm/session';
import { Pkt, buildControl } from '../src/main/kvm/ivtp';
import { fail, parseTarget } from './args';

const { host, user, password } = parseTarget('probe:vmedia');

const IUSB_SIGNATURE = Buffer.from('IUSB    ', 'ascii');
const HEADER_SIZE = 32;
const AUTH_OPCODE = 0xf2;
const ACK_OPCODE = 0xf1;

function buildHeader(dataLen: number, instance = 0): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  IUSB_SIGNATURE.copy(header, 0);
  header.writeUInt8(1, 8); // major
  header.writeUInt8(0, 9); // minor
  header.writeUInt8(HEADER_SIZE, 10);
  header.writeUInt8(0, 11); // checksum: the BMC does not verify it
  header.writeUInt32LE(dataLen, 12);
  header.writeUInt8(0, 16); // serverCaps
  header.writeUInt8(5, 17); // deviceType: CD-ROM
  header.writeUInt8(1, 18); // protocol
  header.writeUInt8(0x80, 19); // direction
  header.writeUInt8(0, 20); // deviceNumber
  header.writeUInt8(0, 21); // interfaceNumber
  header.writeUInt8(0, 22); // clientData
  header.writeUInt8(instance, 23);
  header.writeUInt32LE(0, 24); // sequenceNumber
  return header;
}

function buildAuth(token: string): Buffer {
  const packet = Buffer.alloc(160);
  buildHeader(128).copy(packet, 0);
  packet.writeUInt8(AUTH_OPCODE, 41); // payload[9] = CDB byte 0
  packet.writeUInt8(0, 62); // payload[30]
  packet.write(token, 63, 'ascii');
  return packet;
}

function dump(label: string, buf: Buffer): void {
  console.log(`\n=== ${label} (${buf.length} bytes) ===`);
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    console.log(`  ${i.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
}

/** Decodes as much as the decompiled code explains. */
function describeRequest(packet: Buffer): void {
  const dataLen = packet.readUInt32LE(12);
  const payload = packet.subarray(HEADER_SIZE);
  const cdb = payload.subarray(9, 25);
  console.log(
    `  header: dataPacketLen=${dataLen} seq=${packet.readUInt32LE(24)} ` +
      `instance=${packet.readUInt8(23)} direction=0x${packet.readUInt8(19).toString(16)}`,
  );
  console.log(`  payload[0..8]  = ${hex(payload.subarray(0, 9))}   <- purpose unknown`);
  console.log(`  payload[9..24] = ${hex(cdb)}   <- CDB, opcode 0x${cdb[0].toString(16)}`);
  console.log(`  payload[25..29]= ${hex(payload.subarray(25, 30))}   <- purpose unknown`);
  if (payload.length > 30) {
    console.log(`  data after the SCSI struct: ${payload.length - 30} bytes`);
  }
}

function hex(buf: Buffer): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

async function main() {
  const { session, credentials } = await connect(host, user, password);
  console.log(`kvmToken=${credentials.kvmToken}, CD-ROM port ${credentials.cdPort}`);

  // The original client opens Virtual Media on top of a live KVM session and
  // announces media readiness with a MEDIA_STATE packet on the KVM channel.
  const kvm = new KvmSession(credentials);
  await new Promise<void>((resolve, reject) => {
    kvm.once('authenticated', resolve);
    kvm.once('error', reject);
    kvm.connect();
    setTimeout(() => reject(new Error('KVM session did not come up')), 20_000);
  });
  console.log('KVM session established');

  const socket = net.connect(credentials.cdPort, host);
  let rx = Buffer.alloc(0);
  let requests = 0;

  const finish = (reason: string) => {
    console.log(`\n${reason}`);
    socket.destroy();
    kvm.close();
    void logout(session).then(() => process.exit(0));
  };

  socket.on('connect', () => {
    console.log('TCP connected, sending AUTH');
    socket.write(buildAuth(credentials.kvmToken));
  });

  socket.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);

    while (rx.length >= HEADER_SIZE) {
      const dataLen = rx.readUInt32LE(12);
      if (rx.length < HEADER_SIZE + dataLen) return;

      const packet = rx.subarray(0, HEADER_SIZE + dataLen);
      rx = rx.subarray(HEADER_SIZE + dataLen);

      const opcode = packet.readUInt8(41);
      if (opcode === ACK_OPCODE) {
        const status = packet.readUInt8(62);
        const otherIp = packet.subarray(63, 87).toString('ascii').replace(/\0.*$/s, '').trim();
        console.log(
          `\nACK: connectionStatus=${status} ` +
            `${status === 1 ? '(connection accepted)' : `(refused, taken by: ${otherIp})`}`,
        );
        dump('ACK', packet);
        if (status !== 1) {
          finish('The BMC refused the connection');
          return;
        }
        // Tell the BMC the medium is inserted: IVTP_MEDIA_STATE with status 1.
        console.log('Sending MEDIA_STATE=1 on the KVM channel, waiting for SCSI requests…');
        kvm.send(buildControl(Pkt.MEDIA_STATE, 1));
        continue;
      }

      requests++;
      console.log(`\n--- Request #${requests} from the BMC ---`);
      describeRequest(packet);
      dump(`Request #${requests}`, packet);

      // Nothing is answered: the point is to see what the BMC sends first.
      if (requests >= 3) finish('Collected enough requests');
    }
  });

  socket.on('error', (err) => finish(`Socket error: ${err.message}`));
  socket.on('close', () => finish('Connection closed by the BMC'));

  setTimeout(() => finish(`Timed out: ${requests} requests received`), 20_000);
}

main().catch(fail);
