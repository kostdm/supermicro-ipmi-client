import { describe, expect, it } from 'vitest';
import {
  ADVANCED_FIELDS,
  BANDWIDTH_CHOICES,
  DEFAULT_ADVANCED,
  isDefaultAdvanced,
  resolveAdvanced,
  stripDefaults,
} from '../src/shared/settings';

describe('advanced settings', () => {
  it('describes every field exactly once', () => {
    const keys = ADVANCED_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(DEFAULT_ADVANCED).sort());
  });

  it('has defaults inside the bounds it enforces', () => {
    for (const field of ADVANCED_FIELDS) {
      const value = DEFAULT_ADVANCED[field.key];
      if (field.kind === 'number') {
        expect(typeof value).toBe('number');
        expect(value as number).toBeGreaterThanOrEqual(field.min);
        expect(value as number).toBeLessThanOrEqual(field.max);
      } else if (field.kind === 'choice') {
        expect(field.values).toContain(value as number);
      }
    }
  });

  it('offers the default bandwidth among its choices', () => {
    expect(BANDWIDTH_CHOICES.map((choice) => choice.value)).toContain(
      DEFAULT_ADVANCED.bandwidthBytesPerSecond,
    );
  });
});

describe('resolveAdvanced', () => {
  it('returns the defaults for an absent or empty fragment', () => {
    expect(resolveAdvanced()).toEqual(DEFAULT_ADVANCED);
    expect(resolveAdvanced(null)).toEqual(DEFAULT_ADVANCED);
    expect(resolveAdvanced({})).toEqual(DEFAULT_ADVANCED);
  });

  it('takes the values a profile does carry', () => {
    const resolved = resolveAdvanced({ ipmiTimeoutMs: 9000, insecureTls: false });
    expect(resolved.ipmiTimeoutMs).toBe(9000);
    expect(resolved.insecureTls).toBe(false);
    // Everything else stays on the default.
    expect(resolved.ipmiPort).toBe(DEFAULT_ADVANCED.ipmiPort);
  });

  it('falls back to the default for a value out of range', () => {
    // servers.json is editable by hand, and a session must not start with a
    // timeout of zero because of a stray edit.
    expect(resolveAdvanced({ ipmiTimeoutMs: 0 }).ipmiTimeoutMs).toBe(
      DEFAULT_ADVANCED.ipmiTimeoutMs,
    );
    expect(resolveAdvanced({ ipmiPort: 70_000 }).ipmiPort).toBe(DEFAULT_ADVANCED.ipmiPort);
  });

  it('falls back to the default for a value of the wrong type', () => {
    const stored = { ipmiPort: '623', insecureTls: 'yes' } as never;
    expect(resolveAdvanced(stored)).toEqual(DEFAULT_ADVANCED);
  });

  it('rejects a bandwidth the BMC would not understand', () => {
    expect(resolveAdvanced({ bandwidthBytesPerSecond: 12345 })).toEqual(DEFAULT_ADVANCED);
  });

  it('rounds a fractional millisecond value', () => {
    expect(resolveAdvanced({ mouseThrottleMs: 60.7 }).mouseThrottleMs).toBe(61);
  });
});

describe('stripDefaults', () => {
  it('stores nothing when a profile runs on the defaults', () => {
    expect(stripDefaults(DEFAULT_ADVANCED)).toEqual({});
    expect(isDefaultAdvanced(DEFAULT_ADVANCED)).toBe(true);
  });

  it('keeps only what differs', () => {
    const settings = { ...DEFAULT_ADVANCED, cdPort: 5200 };
    expect(stripDefaults(settings)).toEqual({ cdPort: 5200 });
    expect(isDefaultAdvanced(settings)).toBe(false);
  });

  it('round-trips through resolveAdvanced', () => {
    const settings = { ...DEFAULT_ADVANCED, ipmiRetries: 5, insecureTls: false };
    expect(resolveAdvanced(stripDefaults(settings))).toEqual(settings);
  });
});
