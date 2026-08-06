/**
 * Per-server advanced settings.
 *
 * These are the timings and ports the client used to hold as constants. They
 * are per server rather than global because they describe the far end, not
 * this machine: a BMC on a congested link needs a longer IPMI timeout, an old
 * firmware wants less bandwidth, and a rebuilt BMC may listen for CD
 * redirection somewhere other than the usual port.
 *
 * A profile stores only what differs from the defaults, so a default that
 * changes in a later version reaches everyone who never touched that field.
 */

export interface AdvancedSettings {
  /** Timeout of a request to the BMC web interface, in milliseconds. */
  httpTimeoutMs: number;
  /**
   * Accept the BMC's self-signed certificate.
   *
   * On by default: BMC certificates are almost always self-signed and
   * verification makes the connection impossible. Turn it off once the BMC
   * carries a certificate from your own CA.
   */
  insecureTls: boolean;

  /** SET_BANDWIDTH value for the KVM stream, in bytes per second. */
  bandwidthBytesPerSecond: number;
  /** How often mouse movement is sent to the server, in milliseconds. */
  mouseThrottleMs: number;
  /** How often a full frame is asked for while the screen is blank. */
  blankRetryMs: number;
  /** Hold time before the on-screen keyboard starts repeating a key. */
  keyRepeatDelayMs: number;
  /** Interval between repeats of a held on-screen key. */
  keyRepeatIntervalMs: number;

  /** Port of IPMI over LAN. */
  ipmiPort: number;
  /** How long to wait for a BMC reply before retrying. */
  ipmiTimeoutMs: number;
  /** How many times a request is repeated after a timeout. */
  ipmiRetries: number;
  /** How often the sensor panel refreshes itself. */
  sensorRefreshMs: number;

  /**
   * CD redirection port, used when the BMC reports no usable one of its own.
   */
  cdPort: number;
}

export const DEFAULT_ADVANCED: AdvancedSettings = {
  httpTimeoutMs: 15_000,
  insecureTls: true,

  bandwidthBytesPerSecond: 0xc80000,
  mouseThrottleMs: 60,
  blankRetryMs: 1000,
  keyRepeatDelayMs: 400,
  keyRepeatIntervalMs: 60,

  ipmiPort: 623,
  ipmiTimeoutMs: 4000,
  ipmiRetries: 2,
  sensorRefreshMs: 15_000,

  cdPort: 5120,
};

/** Bandwidth values the BMC understands, in bytes per second. */
export const BANDWIDTH_CHOICES = [
  { value: 0xc80000, labelKey: 'advanced.bandwidth.100' },
  { value: 0x140000, labelKey: 'advanced.bandwidth.10' },
  { value: 131072, labelKey: 'advanced.bandwidth.1' },
] as const;

export type AdvancedFieldSpec =
  | {
      key: keyof AdvancedSettings;
      kind: 'number';
      /** Inclusive bounds; anything outside falls back to the default. */
      min: number;
      max: number;
    }
  | { key: keyof AdvancedSettings; kind: 'boolean' }
  | { key: keyof AdvancedSettings; kind: 'choice'; values: readonly number[] };

/**
 * Field descriptions, in the order the form shows them. The bounds are wide
 * on purpose: they exist to keep a typo from bricking a profile, not to say
 * what a sensible value is.
 */
export const ADVANCED_FIELDS: readonly AdvancedFieldSpec[] = [
  { key: 'httpTimeoutMs', kind: 'number', min: 1000, max: 120_000 },
  { key: 'insecureTls', kind: 'boolean' },
  {
    key: 'bandwidthBytesPerSecond',
    kind: 'choice',
    values: BANDWIDTH_CHOICES.map((choice) => choice.value),
  },
  { key: 'mouseThrottleMs', kind: 'number', min: 0, max: 1000 },
  { key: 'blankRetryMs', kind: 'number', min: 200, max: 60_000 },
  { key: 'keyRepeatDelayMs', kind: 'number', min: 100, max: 5000 },
  { key: 'keyRepeatIntervalMs', kind: 'number', min: 10, max: 2000 },
  { key: 'ipmiPort', kind: 'number', min: 1, max: 65_535 },
  { key: 'ipmiTimeoutMs', kind: 'number', min: 500, max: 60_000 },
  { key: 'ipmiRetries', kind: 'number', min: 0, max: 10 },
  { key: 'sensorRefreshMs', kind: 'number', min: 1000, max: 600_000 },
  { key: 'cdPort', kind: 'number', min: 1, max: 65_535 },
];

/**
 * Fills a stored fragment out into a complete set.
 *
 * Values that are missing, of the wrong type or out of range fall back to the
 * default: the file is editable by hand, and a session must not start with a
 * timeout of zero because of a stray edit.
 */
export function resolveAdvanced(stored?: Partial<AdvancedSettings> | null): AdvancedSettings {
  const result = { ...DEFAULT_ADVANCED };
  if (!stored) return result;

  for (const field of ADVANCED_FIELDS) {
    const value = stored[field.key];
    if (value === undefined) continue;

    if (field.kind === 'boolean') {
      if (typeof value === 'boolean') result[field.key] = value as never;
      continue;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) continue;

    if (field.kind === 'choice') {
      if (field.values.includes(value)) result[field.key] = value as never;
      continue;
    }

    if (value >= field.min && value <= field.max) {
      result[field.key] = Math.round(value) as never;
    }
  }

  return result;
}

/** Keeps only the values that differ from the defaults. */
export function stripDefaults(settings: AdvancedSettings): Partial<AdvancedSettings> {
  const result: Partial<AdvancedSettings> = {};
  for (const field of ADVANCED_FIELDS) {
    if (settings[field.key] !== DEFAULT_ADVANCED[field.key]) {
      result[field.key] = settings[field.key] as never;
    }
  }
  return result;
}

/** Whether a profile still runs entirely on the defaults. */
export function isDefaultAdvanced(settings: AdvancedSettings): boolean {
  return ADVANCED_FIELDS.every((field) => settings[field.key] === DEFAULT_ADVANCED[field.key]);
}
