import { useEffect, useState } from 'react';
import type { DiscoveredServer, ScanRange, ServerProfile } from '@shared/types';
import { LOCALES, type Locale } from '@shared/i18n';
import {
  ADVANCED_FIELDS,
  BANDWIDTH_CHOICES,
  DEFAULT_ADVANCED,
  isDefaultAdvanced,
  resolveAdvanced,
  stripDefaults,
  type AdvancedSettings,
} from '@shared/settings';
import { useI18n } from '../i18n';

interface Props {
  onConnect: (server: ServerProfile, password: string) => void;
  busy: boolean;
  error: string | null;
}

const EMPTY_FORM = { id: '', name: '', host: '', port: 80, username: 'ADMIN', password: '' };

/** A neutral example, not a real address. */
const HOST_PLACEHOLDER = '10.0.0.5';

const LOCALE_NAMES: Record<Locale, string> = { en: 'EN', ru: 'RU' };

/** The list of saved BMCs and the form for adding one. */
export function ServerList({ onConnect, busy, error }: Props) {
  const { t, te, locale, setLocale } = useI18n();
  const [servers, setServers] = useState<ServerProfile[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  /** Always a complete set — the form edits resolved values, not a fragment. */
  const [advanced, setAdvanced] = useState<AdvancedSettings>(DEFAULT_ADVANCED);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [canSavePasswords, setCanSavePasswords] = useState(true);
  const [promptFor, setPromptFor] = useState<ServerProfile | null>(null);
  const [promptPassword, setPromptPassword] = useState('');

  const [scanOpen, setScanOpen] = useState(false);
  const [range, setRange] = useState<ScanRange>({ from: '', to: '' });
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState({ done: 0, total: 0 });
  const [found, setFound] = useState<DiscoveredServer[]>([]);
  /** null until a scan has finished at least once — tells "nothing yet" from "nothing found". */
  const [scanComplete, setScanComplete] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const reload = () => {
    void window.api.listServers().then(setServers);
  };

  useEffect(() => {
    reload();
    void window.api.canStorePasswords().then(setCanSavePasswords);
    // The range of this machine's own network is the one worth offering.
    void window.api.getLocalScanRange().then((local) => {
      if (local) setRange(local);
    });
  }, []);

  // Replies come in while the sweep runs, so the list fills as it goes.
  useEffect(() => {
    return window.api.onScanProgress((progress) => {
      setScanned({ done: progress.scanned, total: progress.total });
      setFound(progress.found);
    });
  }, []);

  const handleScan = async () => {
    setScanning(true);
    setScanComplete(false);
    setScanError(null);
    setFound([]);
    setScanned({ done: 0, total: 0 });
    try {
      setFound(await window.api.scanNetwork(range));
      setScanComplete(true);
    } catch (err) {
      setScanError(te(err));
    } finally {
      setScanning(false);
    }
  };

  const handleStopScan = async () => {
    await window.api.cancelScan();
    setScanning(false);
  };

  /** Prefills the form: everything but the address still has to be filled in. */
  const handleAddFound = (server: DiscoveredServer) => {
    setForm({ ...EMPTY_FORM, host: server.host, name: server.host });
    setAdvanced(DEFAULT_ADVANCED);
    setAdvancedOpen(false);
    setEditing(true);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    await window.api.saveServer({
      id: form.id || undefined,
      name: form.name || form.host,
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password || undefined,
      // Resolved first: a field left empty or out of range comes back as its
      // default rather than being stored as a zero.
      advanced: stripDefaults(resolveAdvanced(advanced)),
    });
    setForm(EMPTY_FORM);
    setAdvanced(DEFAULT_ADVANCED);
    setEditing(false);
    setAdvancedOpen(false);
    reload();
  };

  const handleConnect = async (server: ServerProfile) => {
    const saved = await window.api.getServerPassword(server.id);
    if (saved) {
      onConnect(server, saved);
      return;
    }
    // No stored password — ask before connecting.
    setPromptFor(server);
    setPromptPassword('');
  };

  const handleDelete = async (server: ServerProfile) => {
    await window.api.deleteServer(server.id);
    reload();
  };

  return (
    <div className="servers">
      <header className="servers__header">
        <h1>{t('servers.title')}</h1>
        <div className="servers__actions">
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
          <button
            type="button"
            className={scanOpen ? 'button button--active' : 'button'}
            data-testid="scan-toggle"
            onClick={() => setScanOpen((value) => !value)}
          >
            {t('scan.toggle')}
          </button>
          <button
            type="button"
            className="button"
            data-testid="add-server"
            onClick={() => {
              setForm(EMPTY_FORM);
              setAdvanced(DEFAULT_ADVANCED);
              setAdvancedOpen(false);
              setEditing((value) => !value);
            }}
          >
            {editing ? t('common.cancel') : t('servers.add')}
          </button>
        </div>
      </header>

      {error && <div className="alert alert--error">{error}</div>}

      {scanOpen && (
        <section className="scan">
          <div className="scan__controls">
            <label className="field field--inline">
              <span>{t('scan.from')}</span>
              <input
                value={range.from}
                data-testid="scan-from"
                disabled={scanning}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </label>
            <label className="field field--inline">
              <span>{t('scan.to')}</span>
              <input
                value={range.to}
                data-testid="scan-to"
                disabled={scanning}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </label>
            {scanning ? (
              <button type="button" className="button" onClick={() => void handleStopScan()}>
                {t('scan.stop')}
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                data-testid="scan-start"
                onClick={() => void handleScan()}
              >
                {t('scan.start')}
              </button>
            )}
          </div>

          <p className="hint">{t('scan.hint')}</p>

          {scanError && <div className="alert alert--error">{scanError}</div>}

          {scanning && (
            <div className="scan__progress">
              <div
                className="scan__bar"
                style={{
                  width: scanned.total > 0 ? `${(scanned.done / scanned.total) * 100}%` : '0%',
                }}
              />
              <span className="scan__counter">
                {t('scan.progress', {
                  percent:
                    scanned.total > 0 ? Math.round((scanned.done / scanned.total) * 100) : 0,
                })}
              </span>
            </div>
          )}

          {found.length > 0 && (
            <ul className="scan__results">
              {found.map((server) => {
                const known = servers.some((saved) => saved.host === server.host);
                return (
                  <li key={server.host} className="scan__result">
                    <div className="server-card__info">
                      <span className="server-card__name">{server.host}</span>
                      <span className="server-card__host">
                        IPMI {server.ipmiVersion}
                        {server.vendor ? ` · ${server.vendor}` : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button"
                      disabled={known}
                      onClick={() => handleAddFound(server)}
                    >
                      {known ? t('scan.added') : t('scan.add')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {scanComplete && found.length === 0 && <p className="hint">{t('scan.none')}</p>}
        </section>
      )}

      {servers.length === 0 && !editing && <p className="servers__empty">{t('servers.empty')}</p>}

      <ul className="servers__list">
        {servers.map((server) => (
          <li key={server.id} className="server-card">
            <div className="server-card__info">
              <span className="server-card__name">{server.name}</span>
              <span className="server-card__host">
                {server.host}:{server.port} · {server.username}
                {server.hasSavedPassword ? ` · ${t('servers.passwordSaved')}` : ''}
              </span>
            </div>
            <div className="server-card__actions">
              <button
                type="button"
                className="button button--primary"
                data-testid="connect"
                disabled={busy}
                onClick={() => void handleConnect(server)}
              >
                {t('servers.connect')}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setForm({ ...server, password: '' });
                  const settings = resolveAdvanced(server.advanced);
                  setAdvanced(settings);
                  // A profile that already differs from the defaults opens
                  // with the block unfolded — that is why it was opened.
                  setAdvancedOpen(!isDefaultAdvanced(settings));
                  setEditing(true);
                }}
              >
                {t('servers.edit')}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void handleDelete(server)}
              >
                {t('servers.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <form className="form" onSubmit={(event) => void handleSave(event)}>
          <h2>{form.id ? t('servers.editTitle') : t('servers.newTitle')}</h2>
          <label className="field">
            <span>{t('servers.name')}</span>
            <input
              value={form.name}
              data-testid="field-name"
              placeholder={t('servers.namePlaceholder')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('servers.host')}</span>
            <input
              required
              value={form.host}
              data-testid="field-host"
              placeholder={HOST_PLACEHOLDER}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('servers.port')}</span>
            <input
              type="number"
              required
              value={form.port}
              data-testid="field-port"
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>{t('servers.user')}</span>
            <input
              required
              value={form.username}
              data-testid="field-user"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
          <label className="field">
            <span>
              {t('servers.password')} {canSavePasswords ? t('servers.passwordStored') : ''}
            </span>
            <input
              type="password"
              value={form.password}
              data-testid="field-password"
              placeholder={form.id ? t('servers.passwordKeep') : ''}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          {!canSavePasswords && <p className="hint">{t('servers.noSecureStorage')}</p>}

          <div className="advanced">
            <button
              type="button"
              className="advanced__toggle"
              data-testid="advanced-toggle"
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              {advancedOpen ? '▾' : '▸'} {t('advanced.title')}
              {!isDefaultAdvanced(advanced) && ` · ${t('advanced.changed')}`}
            </button>

            {advancedOpen && (
              <>
                <p className="hint">{t('advanced.hint')}</p>
                <div className="advanced__grid">
                  {ADVANCED_FIELDS.map((field) => (
                    <label key={field.key} className="field">
                      <span>{t(`advanced.${field.key}`)}</span>
                      {field.kind === 'boolean' ? (
                        <select
                          className="select"
                          value={advanced[field.key] ? 'yes' : 'no'}
                          onChange={(e) =>
                            setAdvanced({ ...advanced, [field.key]: e.target.value === 'yes' })
                          }
                        >
                          <option value="yes">{t('common.yes')}</option>
                          <option value="no">{t('common.no')}</option>
                        </select>
                      ) : field.kind === 'choice' ? (
                        <select
                          className="select"
                          value={String(advanced[field.key])}
                          onChange={(e) =>
                            setAdvanced({ ...advanced, [field.key]: Number(e.target.value) })
                          }
                        >
                          {BANDWIDTH_CHOICES.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {t(choice.labelKey)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="number"
                          min={field.min}
                          max={field.max}
                          value={String(advanced[field.key])}
                          data-testid={`advanced-${field.key}`}
                          onChange={(e) =>
                            setAdvanced({ ...advanced, [field.key]: Number(e.target.value) })
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="button"
                  data-testid="advanced-reset"
                  disabled={isDefaultAdvanced(advanced)}
                  onClick={() => setAdvanced(DEFAULT_ADVANCED)}
                >
                  {t('advanced.reset')}
                </button>
              </>
            )}
          </div>

          <button type="submit" className="button button--primary" data-testid="save-server">
            {t('common.save')}
          </button>
        </form>
      )}

      {promptFor && (
        <div className="modal">
          <form
            className="modal__body"
            onSubmit={(event) => {
              event.preventDefault();
              const server = promptFor;
              setPromptFor(null);
              onConnect(server, promptPassword);
            }}
          >
            <h2>{t('servers.passwordFor', { name: promptFor.name })}</h2>
            <label className="field">
              <span>{t('servers.passwordForUser', { user: promptFor.username })}</span>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                type="password"
                autoFocus
                value={promptPassword}
                onChange={(e) => setPromptPassword(e.target.value)}
              />
            </label>
            <div className="modal__actions">
              <button type="button" className="button" onClick={() => setPromptFor(null)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="button button--primary">
                {t('servers.connect')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
