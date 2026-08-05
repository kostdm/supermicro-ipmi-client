import { useEffect, useState } from 'react';
import type { ServerProfile } from '@shared/types';
import { LOCALES, type Locale } from '@shared/i18n';
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
  const { t, locale, setLocale } = useI18n();
  const [servers, setServers] = useState<ServerProfile[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [canSavePasswords, setCanSavePasswords] = useState(true);
  const [promptFor, setPromptFor] = useState<ServerProfile | null>(null);
  const [promptPassword, setPromptPassword] = useState('');

  const reload = () => {
    void window.api.listServers().then(setServers);
  };

  useEffect(() => {
    reload();
    void window.api.canStorePasswords().then(setCanSavePasswords);
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    await window.api.saveServer({
      id: form.id || undefined,
      name: form.name || form.host,
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password || undefined,
    });
    setForm(EMPTY_FORM);
    setEditing(false);
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
            className="button"
            data-testid="add-server"
            onClick={() => {
              setForm(EMPTY_FORM);
              setEditing((value) => !value);
            }}
          >
            {editing ? t('common.cancel') : t('servers.add')}
          </button>
        </div>
      </header>

      {error && <div className="alert alert--error">{error}</div>}

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
