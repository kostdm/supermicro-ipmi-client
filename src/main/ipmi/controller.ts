import type { IpmiSnapshot } from '@shared/types';
import { DEFAULT_ADVANCED, type AdvancedSettings } from '@shared/settings';
import { IpmiSession } from './session';
import { getChassisStatus, getDeviceId, getSelInfo, readSel, readSensors } from './commands';

/**
 * A wrapper around the IPMI session for the UI.
 *
 * The session is separate from KVM: a different transport (UDP 623) and a
 * different authentication. It is kept open while the user watches sensors.
 */
export class IpmiController {
  private session: IpmiSession | null = null;
  private connecting: Promise<IpmiSession> | null = null;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly settings: AdvancedSettings = DEFAULT_ADVANCED,
  ) {}

  private async ensureSession(): Promise<IpmiSession> {
    if (this.session?.isEstablished) return this.session;
    // Concurrent requests from the UI must not each open a session.
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const session = new IpmiSession({
        host: this.host,
        username: this.username,
        password: this.password,
        port: this.settings.ipmiPort,
        timeoutMs: this.settings.ipmiTimeoutMs,
        retries: this.settings.ipmiRetries,
      });
      await session.connect();
      this.session = session;
      return session;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Collects everything the panel shows: sensors, chassis, the event log. */
  async snapshot(): Promise<IpmiSnapshot> {
    const session = await this.ensureSession();

    const [device, chassis, sensors, selInfo] = await Promise.all([
      getDeviceId(session),
      getChassisStatus(session),
      readSensors(session),
      getSelInfo(session),
    ]);

    const sel = selInfo.entries > 0 ? await readSel(session, 20) : [];

    return {
      device: {
        firmwareVersion: device.firmwareVersion,
        ipmiVersion: device.ipmiVersion,
        manufacturerId: device.manufacturerId,
        productId: device.productId,
      },
      chassis: {
        powerOn: chassis.powerOn,
        lastPowerEvent: chassis.lastPowerEvent,
        powerRestorePolicy: chassis.powerRestorePolicy,
        identifyActive: chassis.identifyActive,
        powerFault: chassis.powerFault,
        powerOverload: chassis.powerOverload,
        coolingFault: chassis.coolingFault,
        driveFault: chassis.driveFault,
        chassisIntrusion: chassis.chassisIntrusion,
      },
      sensors: sensors.map((sensor) => ({
        id: sensor.id,
        name: sensor.name,
        value: sensor.value,
        unit: sensor.unit,
        discrete: sensor.discrete,
        states: sensor.states,
        ok: sensor.ok,
      })),
      selCount: selInfo.entries,
      sel: sel.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp ? entry.timestamp.toISOString() : null,
        sensorType: entry.sensorType,
        sensorNumber: entry.sensorNumber,
        direction: entry.eventDirection,
      })),
    };
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
