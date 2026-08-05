import { useCallback, useEffect, useState } from 'react';
import type { IpmiSensor, IpmiSnapshot } from '@shared/types';
import { useI18n } from '../i18n';

/** How often to refresh readings while the panel is open. */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * Sensors are grouped by unit — the table reads much better that way.
 * Units arrive from main as codes ('V', 'RPM', …) and are translated here.
 */
const GROUPS: Array<{ key: string; units: string[] }> = [
  { key: 'temperature', units: ['C', 'F', 'K'] },
  { key: 'voltage', units: ['V'] },
  { key: 'fans', units: ['RPM'] },
  { key: 'power', units: ['W', 'A'] },
];

function groupSensors(sensors: IpmiSensor[]): Array<{ key: string; items: IpmiSensor[] }> {
  const used = new Set<number>();
  const result = GROUPS.map((group) => {
    const items = sensors.filter((s) => s.value !== null && group.units.includes(s.unit));
    items.forEach((s) => used.add(s.id));
    return { key: group.key, items };
  });

  const rest = sensors.filter((s) => !used.has(s.id) && s.ok);
  if (rest.length) result.push({ key: 'other', items: rest });

  return result.filter((group) => group.items.length > 0);
}

/** Collects the active chassis faults for the status line. */
function faultKeys(snapshot: IpmiSnapshot): string[] {
  const { chassis } = snapshot;
  const list: string[] = [];
  if (chassis.powerFault) list.push('fault.power');
  if (chassis.powerOverload) list.push('fault.overload');
  if (chassis.coolingFault) list.push('fault.cooling');
  if (chassis.driveFault) list.push('fault.drive');
  if (chassis.chassisIntrusion) list.push('fault.intrusion');
  if (chassis.identifyActive) list.push('fault.identify');
  return list;
}

export function SensorPanel() {
  const { t, te, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<IpmiSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await window.api.fetchIpmiSnapshot());
      setError(null);
    } catch (err) {
      setError(te(err));
    } finally {
      setLoading(false);
    }
  }, [te]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error && !snapshot) {
    return (
      <div className="sensors">
        <div className="alert alert--error">{t('sensors.readFailed', { error })}</div>
        <button type="button" className="button" onClick={() => void refresh()}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="sensors">
        <p className="hint">{t('sensors.polling')}</p>
      </div>
    );
  }

  return (
    <div className="sensors">
      <div className="sensors__header">
        <div className="sensors__meta">
          <span>{t('sensors.firmware', { version: snapshot.device.firmwareVersion })}</span>
          <span>{t('sensors.ipmi', { version: snapshot.device.ipmiVersion })}</span>
          <span>{snapshot.chassis.powerOn ? t('sensors.chassisOn') : t('sensors.chassisOff')}</span>
          <span>{t('sensors.lastEvent', { event: t(snapshot.chassis.lastPowerEvent) })}</span>
          <span>
            {t('sensors.restorePolicy', { policy: t(snapshot.chassis.powerRestorePolicy) })}
          </span>
          {faultKeys(snapshot).map((key) => (
            <span key={key} className="sensors__fault">
              {t(key)}
            </span>
          ))}
        </div>
        <button type="button" className="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? t('sensors.refreshing') : t('sensors.refresh')}
        </button>
      </div>

      {error && <div className="alert alert--error">{t('sensors.lastPollFailed', { error })}</div>}

      <div className="sensors__groups">
        {groupSensors(snapshot.sensors).map((group) => (
          <section key={group.key} className="sensor-group">
            <h3>{t(`sensors.group.${group.key}`)}</h3>
            <table className="sensor-table">
              <tbody>
                {group.items.map((sensor) => (
                  <tr key={sensor.id} className={sensor.states.length ? 'sensor--alarm' : ''}>
                    <td className="sensor-table__name">{sensor.name}</td>
                    <td className="sensor-table__value">
                      {sensor.value === null ? '—' : sensor.value}{' '}
                      {sensor.unit ? t(`unit.${sensor.unit}`) : ''}
                    </td>
                    <td className="sensor-table__state">
                      {sensor.states.map((state) => t(state)).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>

      <section className="sensor-group">
        <h3>{t('sel.title', { count: snapshot.selCount })}</h3>
        {snapshot.sel.length === 0 ? (
          <p className="hint">{t('sel.empty')}</p>
        ) : (
          <table className="sensor-table">
            <tbody>
              {snapshot.sel.map((entry) => (
                <tr key={entry.id}>
                  <td className="sensor-table__name">
                    {entry.timestamp
                      ? new Date(entry.timestamp).toLocaleString(locale)
                      : t('sel.noTimestamp')}
                  </td>
                  <td className="sensor-table__value">
                    {t('sel.entry', {
                      number: entry.sensorNumber,
                      type: entry.sensorType.toString(16),
                    })}
                  </td>
                  <td className="sensor-table__state">
                    {entry.direction === 'assert' ? t('sel.assert') : t('sel.deassert')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
