import { useCallback, useEffect, useState } from 'react';
import type {
  KvmStatus,
  MouseMode,
  PowerCommand,
  ServerProfile,
  VirtualMediaKind,
  VirtualMediaServices,
  VirtualMediaState,
} from '@shared/types';
import { DEFAULT_ADVANCED, resolveAdvanced, type AdvancedSettings } from '@shared/settings';
import { KvmConsole } from './components/KvmConsole';
import { SensorPanel } from './components/SensorPanel';
import { ServerList } from './components/ServerList';
import { Toolbar } from './components/Toolbar';
import { VirtualKeyboard } from './components/VirtualKeyboard';
import { useI18n } from './i18n';

type Tab = 'console' | 'sensors';

export function App() {
  const { t, tm, te } = useI18n();
  const [tab, setTab] = useState<Tab>('console');
  const [status, setStatus] = useState<KvmStatus>({ kind: 'idle' });
  const [server, setServer] = useState<ServerProfile | null>(null);
  /** Advanced settings of the server in session, resolved against the defaults. */
  const [advanced, setAdvanced] = useState<AdvancedSettings>(DEFAULT_ADVANCED);
  const [powerOn, setPowerOn] = useState<boolean | null>(null);
  const [mouseMode, setMouseMode] = useState<MouseMode>('absolute');
  const [keyboardLeds, setKeyboardLeds] = useState(0);
  const [activeClients, setActiveClients] = useState<string[]>([]);
  /** Shown as the monitor indicator in the toolbar. */
  const [videoSignal, setVideoSignal] = useState(false);
  const [virtualMedia, setVirtualMedia] = useState<VirtualMediaState>({ mounted: false });
  /** Assume both are there until the BMC says otherwise. */
  const [mediaServices, setMediaServices] = useState<VirtualMediaServices>({
    cdrom: true,
    harddisk: true,
  });
  const [keysVisible, setKeysVisible] = useState(false);
  /*
   * Notices are stored as a key plus parameters rather than as finished text,
   * so switching the language retranslates whatever is currently on screen.
   */
  const [notice, setNotice] = useState<{ key: string; params?: Record<string, string | number> } | null>(
    null,
  );

  useEffect(() => {
    return window.api.onEvent((event) => {
      switch (event.type) {
        case 'status':
          setStatus(event.status);
          if (event.status.kind === 'idle' || event.status.kind === 'closed') {
            setPowerOn(null);
            setActiveClients([]);
            setVideoSignal(false);
          }
          break;
        case 'powerStatus':
          setPowerOn(event.on);
          break;
        case 'powerResponse':
          setNotice(
            event.ok
              ? { key: 'notice.powerOk' }
              : { key: 'notice.powerRejected', params: { code: event.code } },
          );
          break;
        case 'mouseMode':
          setMouseMode(event.mode);
          break;
        case 'keyboardLeds':
          setKeyboardLeds(event.leds);
          break;
        case 'activeClients':
          setActiveClients(event.clients);
          break;
        case 'videoSignal':
          setVideoSignal(event.present);
          break;
        case 'virtualMedia':
          setVirtualMedia(event.state);
          if (event.state.ejectedByGuest) setNotice({ key: 'notice.mediaEjected' });
          if (event.state.lastError) {
            setNotice({ key: event.state.lastError.key, params: event.state.lastError.params });
          }
          break;
        case 'mediaServices':
          setMediaServices(event.services);
          break;
      }
    });
  }, []);

  // Notices live for a few seconds and fade out on their own.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleConnect = useCallback(
    async (target: ServerProfile, password: string) => {
      const settings = resolveAdvanced(target.advanced);
      setServer(target);
      setAdvanced(settings);
      setStatus({ kind: 'connecting' });
      try {
        await window.api.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          password,
          advanced: settings,
        });
      } catch (err) {
        setStatus({ kind: 'error', message: te(err) });
        setServer(null);
      }
    },
    [te],
  );

  const handleDisconnect = useCallback(async () => {
    await window.api.disconnect();
    setServer(null);
    setStatus({ kind: 'idle' });
    setTab('console');
  }, []);

  const handlePower = useCallback(
    async (command: PowerCommand) => {
      // A power command that goes nowhere used to fail in silence: it was sent
      // into the KVM channel, and a channel that is not up swallowed it.
      try {
        await window.api.sendPower(command);
      } catch (err) {
        setNotice({ key: 'notice.powerFailed', params: { error: te(err) } });
      }
    },
    [te],
  );

  const handleMouseMode = useCallback((mode: MouseMode) => {
    setMouseMode(mode);
    void window.api.setMouseMode(mode);
  }, []);

  const handleNeedFullScreen = useCallback(() => {
    void window.api.refreshScreen();
  }, []);

  const handleMountIso = useCallback(
    async (kind: VirtualMediaKind) => {
      const isoPath = await window.api.chooseIso();
      if (!isoPath) return;
      try {
        await window.api.mountIso(isoPath, kind);
        setNotice({ key: 'notice.isoMounted' });
      } catch (err) {
        setNotice({ key: 'notice.isoMountFailed', params: { error: te(err) } });
      }
    },
    [te],
  );

  const handleUnmountIso = useCallback(async () => {
    await window.api.unmountIso();
    setNotice({ key: 'notice.isoUnmounted' });
  }, []);

  const connected = status.kind === 'connected';
  const sessionActive = server !== null && status.kind !== 'error' && status.kind !== 'idle';

  if (!sessionActive) {
    return (
      <ServerList
        onConnect={(target, password) => void handleConnect(target, password)}
        busy={status.kind === 'connecting'}
        error={
          status.kind === 'error'
            ? status.message
            : status.kind === 'closed'
              ? tm(status.reason)
              : null
        }
      />
    );
  }

  return (
    <div className="session">
      <Toolbar
        serverName={server.name}
        powerOn={powerOn}
        mouseMode={mouseMode}
        keyboardLeds={keyboardLeds}
        activeClients={activeClients}
        videoSignal={videoSignal}
        onDisconnect={() => void handleDisconnect()}
        onRefresh={() => void window.api.refreshScreen()}
        onCtrlAltDel={() => void window.api.sendCtrlAltDel()}
        onPower={(command) => void handlePower(command)}
        onMouseMode={handleMouseMode}
        tab={tab}
        onTabChange={setTab}
        virtualMedia={virtualMedia}
        mediaServices={mediaServices}
        keysVisible={keysVisible}
        onMountIso={(kind) => void handleMountIso(kind)}
        onUnmountIso={() => void handleUnmountIso()}
        onToggleKeys={() => setKeysVisible((visible) => !visible)}
      />

      {status.kind !== 'connected' && (
        <div className="alert">
          {status.kind === 'connecting' && t('status.connecting')}
          {status.kind === 'authenticating' && t('status.authenticating')}
          {status.kind === 'closed' && tm(status.reason)}
        </div>
      )}

      {notice && <div className="alert alert--notice">{t(notice.key, notice.params)}</div>}

      {/*
        The console is not unmounted when switching to sensors: the decoder
        worker holds the screen state, and recreating it would cost a full frame.
      */}
      <div className="session__pane" hidden={tab !== 'console'}>
        <KvmConsole
          mouseMode={mouseMode}
          inputEnabled={connected && tab === 'console'}
          mouseThrottleMs={advanced.mouseThrottleMs}
          onNeedFullScreen={handleNeedFullScreen}
        />
      </div>

      {tab === 'sensors' && (
        <div className="session__pane session__pane--scroll">
          <SensorPanel refreshIntervalMs={advanced.sensorRefreshMs} />
        </div>
      )}

      {/* The keyboard sits below the screen, like a system on-screen keyboard. */}
      {keysVisible && tab === 'console' && (
        <VirtualKeyboard
          enabled={connected}
          leds={keyboardLeds}
          repeatDelayMs={advanced.keyRepeatDelayMs}
          repeatIntervalMs={advanced.keyRepeatIntervalMs}
        />
      )}
    </div>
  );
}
