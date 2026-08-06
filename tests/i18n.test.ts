import { describe, expect, it } from 'vitest';
import { LOCALES, translate, translationKeys } from '../src/shared/i18n';
import { ADVANCED_FIELDS, BANDWIDTH_CHOICES } from '../src/shared/settings';

/**
 * A missing key is not a runtime error — `translate` falls back to English and
 * then to the key itself, so an untranslated label reaches the screen looking
 * like `advanced.cdPort`. These tests are what catches that.
 */
describe('translations', () => {
  it('defines the same keys in every language', () => {
    const english = translationKeys('en');
    for (const locale of LOCALES) {
      expect([...translationKeys(locale)].sort()).toEqual([...english].sort());
    }
  });

  it('leaves no value empty', () => {
    for (const locale of LOCALES) {
      const empty = translationKeys(locale).filter((key) => translate(locale, key).trim() === '');
      expect(empty).toEqual([]);
    }
  });

  it('labels every advanced settings field', () => {
    const keys = [
      ...ADVANCED_FIELDS.map((field) => `advanced.${field.key}`),
      ...BANDWIDTH_CHOICES.map((choice) => choice.labelKey),
      'advanced.title',
      'advanced.hint',
      'advanced.changed',
      'advanced.reset',
    ];

    for (const locale of LOCALES) {
      const untranslated = keys.filter((key) => translate(locale, key) === key);
      expect(untranslated).toEqual([]);
    }
  });
});
