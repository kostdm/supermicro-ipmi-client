/**
 * KeyboardEvent.code -> USB HID Usage ID (Usage Page 0x07).
 *
 * The original JViewer builds four tables keyed by Java KeyEvent plus
 * keyLocation (its USBKeyProcessorEnglish class). On the web the job is
 * simpler: KeyboardEvent.code already names the physical key regardless of
 * layout, so one table is enough.
 */

/** Modifier mask bits in the first byte of a keyboard report. */
export const ModifierBit = {
  ControlLeft: 0x01,
  ShiftLeft: 0x02,
  AltLeft: 0x04,
  MetaLeft: 0x08,
  ControlRight: 0x10,
  ShiftRight: 0x20,
  AltRight: 0x40,
  MetaRight: 0x80,
} as const;

export type ModifierCode = keyof typeof ModifierBit;

export function isModifier(code: string): code is ModifierCode {
  return code in ModifierBit;
}

/** Lock keys: the BMC expects an explicit release for these. */
const LOCK_KEYS = new Set(['CapsLock', 'NumLock', 'ScrollLock']);

export function isLockKey(code: string): boolean {
  return LOCK_KEYS.has(code);
}

const KEYMAP: Record<string, number> = {
  // Letters: A=4 ... Z=29.
  KeyA: 4,
  KeyB: 5,
  KeyC: 6,
  KeyD: 7,
  KeyE: 8,
  KeyF: 9,
  KeyG: 10,
  KeyH: 11,
  KeyI: 12,
  KeyJ: 13,
  KeyK: 14,
  KeyL: 15,
  KeyM: 16,
  KeyN: 17,
  KeyO: 18,
  KeyP: 19,
  KeyQ: 20,
  KeyR: 21,
  KeyS: 22,
  KeyT: 23,
  KeyU: 24,
  KeyV: 25,
  KeyW: 26,
  KeyX: 27,
  KeyY: 28,
  KeyZ: 29,

  // Digit row: 1..9 = 30..38, 0 = 39.
  Digit1: 30,
  Digit2: 31,
  Digit3: 32,
  Digit4: 33,
  Digit5: 34,
  Digit6: 35,
  Digit7: 36,
  Digit8: 37,
  Digit9: 38,
  Digit0: 39,

  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,

  F1: 58,
  F2: 59,
  F3: 60,
  F4: 61,
  F5: 62,
  F6: 63,
  F7: 64,
  F8: 65,
  F9: 66,
  F10: 67,
  F11: 68,
  F12: 69,

  PrintScreen: 70,
  ScrollLock: 71,
  Pause: 72,
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,

  NumLock: 83,
  NumpadDivide: 84,
  NumpadMultiply: 85,
  NumpadSubtract: 86,
  NumpadAdd: 87,
  NumpadEnter: 88,
  Numpad1: 89,
  Numpad2: 90,
  Numpad3: 91,
  Numpad4: 92,
  Numpad5: 93,
  Numpad6: 94,
  Numpad7: 95,
  Numpad8: 96,
  Numpad9: 97,
  Numpad0: 98,
  NumpadDecimal: 99,

  IntlBackslash: 100,
  ContextMenu: 101,
  NumpadEqual: 103,

  F13: 104,
  F14: 105,
  F15: 106,
  F16: 107,
  F17: 108,
  F18: 109,
  F19: 110,
  F20: 111,
  F21: 112,
  F22: 113,
  F23: 114,
  F24: 115,

  Help: 117,
  Undo: 122,
  Cut: 123,
  Copy: 124,
  Paste: 125,
  Find: 126,

  IntlRo: 135,
  KanaMode: 136,
  IntlYen: 137,
  Convert: 138,
  NonConvert: 139,

  // Modifiers never land in a key slot, but the codes are here for completeness.
  ControlLeft: 224,
  ShiftLeft: 225,
  AltLeft: 226,
  MetaLeft: 227,
  ControlRight: 228,
  ShiftRight: 229,
  AltRight: 230,
  MetaRight: 231,
};

/** Returns the HID usage for a key, or undefined when it is unknown. */
export function toHidUsage(code: string): number | undefined {
  return KEYMAP[code];
}
