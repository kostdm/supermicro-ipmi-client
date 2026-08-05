/**
 * Checks IPMI over LAN against a live BMC: RAKP authentication, device info,
 * chassis state, sensors and the system event log.
 *
 * Run: npm run check:ipmi -- <host> [user] [password]
 */
import { IpmiSession } from '../src/main/ipmi/session';
import {
  getChassisStatus,
  getDeviceId,
  getSelInfo,
  readSel,
  readSensors,
} from '../src/main/ipmi/commands';
import { fail, parseTarget } from './args';

const { host, user: username, password } = parseTarget('check:ipmi');

async function main() {
  const session = new IpmiSession({ host, username, password });

  console.log(`Opening an IPMI 2.0 session with ${host}:623...`);
  await session.connect();
  console.log('RAKP authentication passed');

  try {
    const device = await getDeviceId(session);
    console.log('\nDevice:');
    console.log(`  BMC firmware : ${device.firmwareVersion}`);
    console.log(`  IPMI version : ${device.ipmiVersion}`);
    console.log(`  manufacturer : ${device.manufacturerId}, product: ${device.productId}`);

    const chassis = await getChassisStatus(session);
    console.log('\nChassis:');
    console.log(`  power             : ${chassis.powerOn ? 'on' : 'off'}`);
    console.log(`  last power event  : ${chassis.lastPowerEvent}`);
    console.log(`  identify LED      : ${chassis.identifyActive ? 'active' : 'off'}`);

    console.log('\nSensors:');
    const sensors = await readSensors(session);
    const analog = sensors.filter((s) => s.value !== null);
    for (const sensor of analog) {
      const alarm = sensor.states.length ? `  ⚠ ${sensor.states.join(', ')}` : '';
      console.log(
        `  ${sensor.name.padEnd(20)} ${String(sensor.value).padStart(9)} ${sensor.unit}${alarm}`,
      );
    }
    console.log(`  (SDR records: ${sensors.length}, with a numeric reading: ${analog.length})`);

    const selInfo = await getSelInfo(session);
    console.log(`\nEvent log: ${selInfo.entries} entries`);
    if (selInfo.entries > 0) {
      const entries = await readSel(session, 5);
      for (const entry of entries) {
        const when = entry.timestamp ? entry.timestamp.toISOString() : 'no timestamp';
        console.log(
          `  #${entry.id} ${when} type 0x${entry.sensorType.toString(16)} ` +
            `sensor ${entry.sensorNumber} (${entry.eventDirection})`,
        );
      }
    }
  } finally {
    session.close();
  }
}

main().catch(fail);
