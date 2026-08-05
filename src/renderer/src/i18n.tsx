import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  formatError,
  formatMessage,
  isLocale,
  pickLocale,
  translate,
  type Locale,
  type Message,
} from '@shared/i18n';

/**
 * Language selection for the renderer.
 *
 * The language is guessed from the system locale on first run and can be
 * overridden from the toolbar; the choice is remembered. The main process is
 * told about it too, because the native file dialog is opened over there and
 * needs its own translated title.
 */

const STORAGE_KEY = 'locale';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Translates a key, interpolating {placeholders}. */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Translates a message that arrived from the main process. */
  tm: (message: Message) => string;
  /** Renders an error: a known message key, or the text as it came. */
  te: (error: unknown) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  // navigator.languages is ordered by preference; Electron fills it from the
  // system settings.
  return pickLocale(navigator.languages ?? [navigator.language ?? DEFAULT_LOCALE]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    window.api.setLocale(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
      tm: (message) => formatMessage(locale, message),
      te: (error) => formatError(locale, error),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
