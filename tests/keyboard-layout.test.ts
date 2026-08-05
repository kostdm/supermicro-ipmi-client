import { describe, expect, it } from 'vitest';
import { isModifier, toHidUsage } from '../src/main/kvm/keymap';
import {
  BLOCKS,
  COMBOS,
  isKey,
  isModifierKey,
  nextStickyState,
  oneShotCodes,
  slotWidth,
  withoutOneShots,
  type StickyMap,
} from '../src/shared/keyboard';

describe('on-screen keyboard layout', () => {
  const keys = BLOCKS.flatMap((block) => block.rows.flat()).filter(isKey);

  it('translates every key into a HID code', () => {
    // A typo in a code raises no runtime error: main simply drops the unknown
    // key, and the button silently does nothing.
    const unknown = keys.filter((key) => toHidUsage(key.code) === undefined);
    expect(unknown.map((key) => key.code)).toEqual([]);
  });

  it('has no duplicate key codes', () => {
    const codes = keys.map((key) => key.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('has rows that add up to the width of their block', () => {
    for (const block of BLOCKS) {
      for (const [index, row] of block.rows.entries()) {
        const width = row.reduce((sum, slot) => sum + slotWidth(slot), 0);
        expect(`${block.name}[${index}]=${width}`).toBe(`${block.name}[${index}]=${block.units}`);
      }
    }
  });

  it('latches exactly the keys main treats as modifiers', () => {
    for (const key of keys) {
      expect(isModifierKey(key.code)).toBe(isModifier(key.code));
    }
  });

  it('uses combination keys main also knows', () => {
    const unknown = COMBOS.flatMap((combo) => combo.keys).filter(
      (code) => toHidUsage(code) === undefined,
    );
    expect(unknown).toEqual([]);
  });
});

describe('sticky modifiers', () => {
  it('cycles the state on every click', () => {
    expect(nextStickyState(undefined)).toBe('once');
    expect(nextStickyState('once')).toBe('lock');
    expect(nextStickyState('lock')).toBeUndefined();
  });

  it('drops only the one-shot modifiers after a key', () => {
    const sticky: StickyMap = { ControlLeft: 'once', ShiftLeft: 'lock' };
    expect(oneShotCodes(sticky)).toEqual(['ControlLeft']);
    expect(withoutOneShots(sticky)).toEqual({ ShiftLeft: 'lock' });
  });
});
