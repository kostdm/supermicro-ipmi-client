/**
 * On-screen keyboard layout and the sticky-modifier state machine.
 *
 * Key codes are the same KeyboardEvent.code values that reach the BMC from a
 * physical keyboard (see main/kvm/keymap.ts), so a mouse click and a real
 * keypress are indistinguishable to the server.
 *
 * Deliberately free of JSX and DOM: the layout is checked by a Node test
 * against the HID code table, so a typo in a code never reaches runtime.
 */

export interface VKey {
  /** KeyboardEvent.code. */
  code: string;
  label: string;
  /** Label shown while Shift is held. */
  shift?: string;
  /** Width in units, 1 being an ordinary key. */
  width?: number;
  /** Translation key for the tooltip. */
  titleKey?: string;
}

/** Empty space in a row: the navigation and numeric blocks have gaps. */
export interface VGap {
  gap: number;
}

export type VSlot = VKey | VGap;

export function isGap(slot: VSlot): slot is VGap {
  return 'gap' in slot;
}

export function isKey(slot: VSlot): slot is VKey {
  return !isGap(slot);
}

/**
 * Modifiers cannot be held down with a mouse, so they latch instead.
 * Matches the set in ModifierBit in main/kvm/keymap.ts.
 */
const MODIFIERS = new Set([
  'ControlLeft',
  'ShiftLeft',
  'AltLeft',
  'MetaLeft',
  'ControlRight',
  'ShiftRight',
  'AltRight',
  'MetaRight',
]);

export function isModifierKey(code: string): boolean {
  return MODIFIERS.has(code);
}

/**
 * State of a latched modifier: `once` releases itself after the next key,
 * `lock` stays down until it is clicked again.
 */
export type StickyState = 'once' | 'lock';

export type StickyMap = Readonly<Record<string, StickyState>>;

/** Clicking a modifier cycles: released → one-shot → held → released. */
export function nextStickyState(current: StickyState | undefined): StickyState | undefined {
  if (current === undefined) return 'once';
  if (current === 'once') return 'lock';
  return undefined;
}

/** Codes of one-shot modifiers — released after an ordinary key is pressed. */
export function oneShotCodes(sticky: StickyMap): string[] {
  return Object.keys(sticky).filter((code) => sticky[code] === 'once');
}

/** Drops the one-shot modifiers from the map, keeping the held ones. */
export function withoutOneShots(sticky: StickyMap): StickyMap {
  const rest: Record<string, StickyState> = {};
  for (const [code, state] of Object.entries(sticky)) {
    if (state === 'lock') rest[code] = state;
  }
  return rest;
}

/** Bits of the LED mask carried by the keyboardLeds event. */
export const LedBit: Record<string, number> = {
  NumLock: 1,
  CapsLock: 2,
  ScrollLock: 4,
};

const K = (code: string, label: string, extra: Partial<VKey> = {}): VKey => ({
  code,
  label,
  ...extra,
});

/** Main block, 15 units wide — the standard ANSI layout. */
export const MAIN_BLOCK: VSlot[][] = [
  [
    K('Escape', 'Esc'),
    { gap: 1 },
    K('F1', 'F1'),
    K('F2', 'F2'),
    K('F3', 'F3'),
    K('F4', 'F4'),
    { gap: 0.5 },
    K('F5', 'F5'),
    K('F6', 'F6'),
    K('F7', 'F7'),
    K('F8', 'F8'),
    { gap: 0.5 },
    K('F9', 'F9'),
    K('F10', 'F10'),
    K('F11', 'F11'),
    K('F12', 'F12'),
  ],
  [
    K('Backquote', '`', { shift: '~' }),
    K('Digit1', '1', { shift: '!' }),
    K('Digit2', '2', { shift: '@' }),
    K('Digit3', '3', { shift: '#' }),
    K('Digit4', '4', { shift: '$' }),
    K('Digit5', '5', { shift: '%' }),
    K('Digit6', '6', { shift: '^' }),
    K('Digit7', '7', { shift: '&' }),
    K('Digit8', '8', { shift: '*' }),
    K('Digit9', '9', { shift: '(' }),
    K('Digit0', '0', { shift: ')' }),
    K('Minus', '-', { shift: '_' }),
    K('Equal', '=', { shift: '+' }),
    K('Backspace', '⌫', { width: 2, titleKey: 'vkbd.backspace' }),
  ],
  [
    K('Tab', 'Tab', { width: 1.5 }),
    K('KeyQ', 'Q'),
    K('KeyW', 'W'),
    K('KeyE', 'E'),
    K('KeyR', 'R'),
    K('KeyT', 'T'),
    K('KeyY', 'Y'),
    K('KeyU', 'U'),
    K('KeyI', 'I'),
    K('KeyO', 'O'),
    K('KeyP', 'P'),
    K('BracketLeft', '[', { shift: '{' }),
    K('BracketRight', ']', { shift: '}' }),
    K('Backslash', '\\', { shift: '|', width: 1.5 }),
  ],
  [
    K('CapsLock', 'Caps', { width: 1.75, titleKey: 'vkbd.capsLock' }),
    K('KeyA', 'A'),
    K('KeyS', 'S'),
    K('KeyD', 'D'),
    K('KeyF', 'F'),
    K('KeyG', 'G'),
    K('KeyH', 'H'),
    K('KeyJ', 'J'),
    K('KeyK', 'K'),
    K('KeyL', 'L'),
    K('Semicolon', ';', { shift: ':' }),
    K('Quote', "'", { shift: '"' }),
    K('Enter', 'Enter', { width: 2.25 }),
  ],
  [
    K('ShiftLeft', 'Shift', { width: 2.25 }),
    K('KeyZ', 'Z'),
    K('KeyX', 'X'),
    K('KeyC', 'C'),
    K('KeyV', 'V'),
    K('KeyB', 'B'),
    K('KeyN', 'N'),
    K('KeyM', 'M'),
    K('Comma', ',', { shift: '<' }),
    K('Period', '.', { shift: '>' }),
    K('Slash', '/', { shift: '?' }),
    K('ShiftRight', 'Shift', { width: 2.75 }),
  ],
  [
    K('ControlLeft', 'Ctrl', { width: 1.25 }),
    K('MetaLeft', 'Win', { width: 1.25, titleKey: 'vkbd.win' }),
    K('AltLeft', 'Alt', { width: 1.25 }),
    K('Space', '', { width: 6.25, titleKey: 'vkbd.space' }),
    K('AltRight', 'Alt', { width: 1.25 }),
    K('MetaRight', 'Win', { width: 1.25, titleKey: 'vkbd.win' }),
    K('ContextMenu', 'Menu', { width: 1.25, titleKey: 'vkbd.menu' }),
    K('ControlRight', 'Ctrl', { width: 1.25 }),
  ],
];

/** Navigation block, 3 units. */
export const NAV_BLOCK: VSlot[][] = [
  [K('PrintScreen', 'PrtSc'), K('ScrollLock', 'ScrLk'), K('Pause', 'Pause')],
  [K('Insert', 'Ins'), K('Home', 'Home'), K('PageUp', 'PgUp')],
  [K('Delete', 'Del'), K('End', 'End'), K('PageDown', 'PgDn')],
  [{ gap: 3 }],
  [{ gap: 1 }, K('ArrowUp', '↑'), { gap: 1 }],
  [K('ArrowLeft', '←'), K('ArrowDown', '↓'), K('ArrowRight', '→')],
];

/**
 * Numeric block, 4 units. The double-height "+" and "Enter" of a real keypad
 * are ordinary keys here: stretching a key across two rows does not work in a
 * flex row, and it makes no difference to the codes that are sent.
 */
export const NUMPAD_BLOCK: VSlot[][] = [
  [{ gap: 4 }],
  [
    K('NumLock', 'Num'),
    K('NumpadDivide', '/'),
    K('NumpadMultiply', '*'),
    K('NumpadSubtract', '−'),
  ],
  [K('Numpad7', '7'), K('Numpad8', '8'), K('Numpad9', '9'), K('NumpadAdd', '+')],
  [K('Numpad4', '4'), K('Numpad5', '5'), K('Numpad6', '6'), { gap: 1 }],
  [K('Numpad1', '1'), K('Numpad2', '2'), K('Numpad3', '3'), K('NumpadEnter', '⏎')],
  [K('Numpad0', '0', { width: 2 }), K('NumpadDecimal', '.'), { gap: 1 }],
];

/**
 * Combinations that never arrive in full: the host window manager swallows
 * them before the event reaches the renderer.
 */
export const COMBOS: Array<{ label: string; titleKey: string; keys: string[] }> = [
  {
    label: 'Ctrl+Alt+Del',
    titleKey: 'combo.ctrlAltDel',
    keys: ['ControlLeft', 'AltLeft', 'Delete'],
  },
  { label: 'Alt+Tab', titleKey: 'combo.altTab', keys: ['AltLeft', 'Tab'] },
  { label: 'Alt+F4', titleKey: 'combo.altF4', keys: ['AltLeft', 'F4'] },
  { label: 'Ctrl+Esc', titleKey: 'combo.ctrlEsc', keys: ['ControlLeft', 'Escape'] },
  { label: 'Win+R', titleKey: 'combo.winR', keys: ['MetaLeft', 'KeyR'] },
  {
    label: 'Ctrl+Shift+Esc',
    titleKey: 'combo.ctrlShiftEsc',
    keys: ['ControlLeft', 'ShiftLeft', 'Escape'],
  },
];

/** Every block in left-to-right drawing order. */
export const BLOCKS: Array<{ name: string; units: number; rows: VSlot[][] }> = [
  { name: 'main', units: 15, rows: MAIN_BLOCK },
  { name: 'nav', units: 3, rows: NAV_BLOCK },
  { name: 'numpad', units: 4, rows: NUMPAD_BLOCK },
];

/** Width of a slot in units. */
export function slotWidth(slot: VSlot): number {
  return isGap(slot) ? slot.gap : (slot.width ?? 1);
}
