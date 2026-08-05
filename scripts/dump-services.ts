/**
 * Dumps the CONF_SERVICE_STATUS packet (type 37), which reveals the real
 * layout of the BMC service records, including the virtual media ports.
 *
 * Run: npm run dump:services -- <host> [user] [password]
 */
import { connect, logout } from '../src/main/bmc/auth';
import { KvmSession } from '../src/main/kvm/session';
import { Pkt } from '../src/main/kvm/ivtp';
import { fail, parseTarget } from './args';

const { host, user, password } = parseTarget('dump:services');

function dump(buf: Buffer, recordSize: number): void {
  console.log(`\nBody length: ${buf.length} bytes`);
  for (const size of [51, 55, buf.length / 5]) {
    if (Number.isInteger(size) && size > 0 && buf.length % size === 0) {
      console.log(`  divides evenly by ${size} -> ${buf.length / size} records`);
    }
  }

  console.log(`\nParsed in ${recordSize}-byte records:`);
  for (let offset = 0; offset + recordSize <= buf.length; offset += recordSize) {
    const record = buf.subarray(offset, offset + recordSize);
    const ascii = [...record]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    console.log(`\n  record @${offset}: ${ascii}`);
    for (let i = 0; i < record.length; i += 16) {
      const slice = record.subarray(i, i + 16);
      console.log(
        `    ${String(i).padStart(3)}  ` +
          [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' '),
      );
    }
  }
}

async function main() {
  const { session: web, credentials } = await connect(host, user, password);
  const kvm = new KvmSession(credentials);

  // Intercept raw packets before parsing: the unprocessed type 37 is the point.
  const raw = kvm as unknown as {
    handlePacket: (type: number, status: number, body: Buffer) => void;
  };
  const original = raw.handlePacket.bind(kvm);
  let captured = false;

  raw.handlePacket = (type, status, body) => {
    if (type === Pkt.CONF_SERVICE_STATUS && !captured) {
      captured = true;
      console.log(`Received CONF_SERVICE_STATUS, status=${status}`);
      dump(body, body.length % 55 === 0 ? 55 : 51);
    }
    original(type, status, body);
  };

  await new Promise<void>((resolve, reject) => {
    kvm.once('authenticated', resolve);
    kvm.once('error', reject);
    kvm.connect();
    setTimeout(() => reject(new Error('KVM session did not come up')), 20_000);
  });

  await new Promise((resolve) => setTimeout(resolve, 6000));
  if (!captured) console.log('No CONF_SERVICE_STATUS packet arrived');

  kvm.close();
  await logout(web);
}

main().catch(fail);
