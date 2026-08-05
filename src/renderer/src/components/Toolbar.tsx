import { useState } from 'react';
import type { MouseMode, PowerCommand, VirtualMediaState } from '@shared/types';
import { LOCALES, type Locale } from '@shared/i18n';
import { useI18n } from '../i18n';

interface Props {
  serverName: string;
  powerOn: boolean | null;
  mouseMode: MouseMode;
  keyboardLeds: number;
  activeClients: string[];
  tab: 'console' | 'sensors';
  virtualMedia: VirtualMediaState;
  keysVisible: boolean;
  onMountIso: () => void;
  onUnmountIso: () => void;
  onToggleKeys: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onCtrlAltDel: () => void;
  onPower: (command: PowerCommand) => void;
  onMouseMode: (mode: MouseMode) => void;
  onTabChange: (tab: 'console' | 'sensors') => void;
}

/** Power commands live in a menu: some of them cut power immediately. */
const POWER_ACTIONS: Array<{ command: PowerCommand; dangerous: boolean }> = [
  { command: 'on', dangerous: false },
  { command: 'orderly-shutdown', dangerous: false },
  { command: 'hard-reset', dangerous: true },
  { command: 'cycle', dangerous: true },
  { command: 'off-immediate', dangerous: true },
];

/** Indicator names are the same in every language. */
const LED_LABELS: Array<[number, string]> = [
  [1, 'Num'],
  [2, 'Caps'],
  [4, 'Scroll'],
];

const LOCALE_NAMES: Record<Locale, string> = { en: 'EN', ru: 'RU' };

export function Toolbar({
  serverName,
  powerOn,
  mouseMode,
  keyboardLeds,
  activeClients,
  tab,
  virtualMedia,
  keysVisible,
  onDisconnect,
  onRefresh,
  onCtrlAltDel,
  onPower,
  onMouseMode,
  onTabChange,
  onMountIso,
  onUnmountIso,
  onToggleKeys,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<PowerCommand | null>(null);

  const runPower = (command: PowerCommand, dangerous: boolean) => {
    setPowerMenuOpen(false);
    if (dangerous) setConfirming(command);
    else onPower(command);
  };

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <button type="button" className="button" data-testid="disconnect" onClick={onDisconnect}>
          {t('toolbar.disconnect')}
        </button>
        <span className="toolbar__title">{serverName}</span>
        <span className={`badge ${powerOn ? 'badge--on' : 'badge--off'}`}>
          {powerOn === null
            ? t('badge.powerUnknown')
            : powerOn
              ? t('badge.powerOn')
              : t('badge.powerOff')}
        </span>

        <div className="tabs">
          <button
            type="button"
            className={tab === 'console' ? 'tab tab--active' : 'tab'}
            data-testid="tab-console"
            onClick={() => onTabChange('console')}
          >
            {t('tabs.console')}
          </button>
          <button
            type="button"
            className={tab === 'sensors' ? 'tab tab--active' : 'tab'}
            data-testid="tab-sensors"
            onClick={() => onTabChange('sensors')}
          >
            {t('tabs.sensors')}
          </button>
        </div>
      </div>

      <div className="toolbar__group">
        <span className="leds">
          {LED_LABELS.map(([bit, label]) => (
            <span key={label} className={`led ${keyboardLeds & bit ? 'led--on' : ''}`}>
              {label}
            </span>
          ))}
        </span>

        <select
          className="select"
          value={mouseMode}
          onChange={(e) => onMouseMode(e.target.value as MouseMode)}
          title={t('toolbar.mouseMode')}
        >
          <option value="absolute">{t('mouse.absolute')}</option>
          <option value="relative">{t('mouse.relative')}</option>
          <option value="other">{t('mouse.other')}</option>
        </select>

        <button type="button" className="button" onClick={onCtrlAltDel}>
          {t('toolbar.ctrlAltDel')}
        </button>
        <button
          type="button"
          className={keysVisible ? 'button button--active' : 'button'}
          onClick={onToggleKeys}
          title={t('toolbar.keyboardTitle')}
        >
          {t('toolbar.keyboard')}
        </button>
        <button type="button" className="button" onClick={onRefresh}>
          {t('toolbar.refresh')}
        </button>

        {virtualMedia.mounted ? (
          <button
            type="button"
            className="button"
            onClick={onUnmountIso}
            title={t('toolbar.mountedTitle', { path: virtualMedia.isoPath ?? '' })}
          >
            {t('toolbar.unmountIso')}
          </button>
        ) : (
          <button type="button" className="button" onClick={onMountIso}>
            {t('toolbar.mountIso')}
          </button>
        )}

        <div className="dropdown">
          <button
            type="button"
            className="button"
            onClick={() => setPowerMenuOpen((open) => !open)}
          >
            {t('toolbar.powerMenu')}
          </button>
          {powerMenuOpen && (
            <ul className="dropdown__menu">
              {POWER_ACTIONS.map((action) => (
                <li key={action.command}>
                  <button
                    type="button"
                    className={
                      action.dangerous
                        ? 'dropdown__item dropdown__item--danger'
                        : 'dropdown__item'
                    }
                    onClick={() => runPower(action.command, action.dangerous)}
                  >
                    {t(`power.${action.command}`)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {activeClients.length > 1 && (
          <span className="badge" title={activeClients.join('\n')}>
            {t('toolbar.sessions', { count: activeClients.length })}
          </span>
        )}

        <select
          className="select select--lang"
          value={locale}
          title={t('common.language')}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {LOCALES.map((code) => (
            <option key={code} value={code}>
              {LOCALE_NAMES[code]}
            </option>
          ))}
        </select>
      </div>

      {confirming && (
        <div className="modal">
          <div className="modal__body">
            <h2>{t('confirm.title')}</h2>
            <p>{t('confirm.body', { action: t(`power.${confirming}`) })}</p>
            <div className="modal__actions">
              <button type="button" className="button" onClick={() => setConfirming(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  onPower(confirming);
                  setConfirming(null);
                }}
              >
                {t('common.execute')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
