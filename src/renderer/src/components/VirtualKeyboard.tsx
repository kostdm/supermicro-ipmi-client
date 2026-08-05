import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BLOCKS,
  COMBOS,
  LedBit,
  isGap,
  isModifierKey,
  nextStickyState,
  oneShotCodes,
  slotWidth,
  withoutOneShots,
  type StickyMap,
  type VKey,
  type VSlot,
} from '@shared/keyboard';
import { useI18n } from '../i18n';

/**
 * On-screen keyboard.
 *
 * Needed because some keypresses never reach the application: on macOS the
 * F1–F12 row is owned by brightness and volume, Cmd+Q closes the window, and
 * Alt+Tab and Win+R are swallowed by the host window manager. Codes go from
 * here straight to the BMC, bypassing the local keyboard stack, so nothing
 * depends on the host's settings or layout.
 *
 * Modifiers latch, because a mouse cannot hold Ctrl down and click another
 * key at the same time. One click arms the modifier for a single key, a
 * second click holds it until clicked again.
 */

interface Props {
  /** Input is only allowed on an established session. */
  enabled: boolean;
  /** Num/Caps/Scroll mask reported by the BMC — lights the indicators. */
  leds: number;
}

/** Delay before auto-repeat kicks in while a key is held, and its period. */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

export function VirtualKeyboard({ enabled, leds }: Props) {
  const { t } = useI18n();
  const [sticky, setSticky] = useState<StickyMap>({});

  // Latched modifiers are physically held down on the BMC side, so closing
  // the panel or losing the session has to release them — otherwise the guest
  // system is left with Ctrl stuck down.
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;

  useEffect(() => {
    return () => {
      for (const code of Object.keys(stickyRef.current)) {
        window.api.sendKey({ code, pressed: false });
      }
    };
  }, []);

  useEffect(() => {
    if (enabled) return;
    // The session is gone — the server-side state is lost anyway.
    setSticky({});
  }, [enabled]);

  const repeatTimers = useRef<{ delay?: number; interval?: number }>({});
  /** The key currently held with the mouse — mouseleave also fires unpressed. */
  const pressedCode = useRef<string | null>(null);

  const stopRepeat = useCallback(() => {
    const { delay, interval } = repeatTimers.current;
    if (delay !== undefined) clearTimeout(delay);
    if (interval !== undefined) clearInterval(interval);
    repeatTimers.current = {};
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);

  /**
   * Press and release an ordinary key. The BMC runs in auto-keybreak mode and
   * releases the key itself, but main filters the redundant half out — here
   * it is enough to send both.
   */
  const tap = useCallback((code: string) => {
    window.api.sendKey({ code, pressed: true });
    window.api.sendKey({ code, pressed: false });
  }, []);

  /** Drops the one-shot modifiers once the key has done its job. */
  const releaseOneShots = useCallback(() => {
    const codes = oneShotCodes(stickyRef.current);
    if (codes.length === 0) return;
    for (const code of codes) window.api.sendKey({ code, pressed: false });
    setSticky(withoutOneShots(stickyRef.current));
  }, []);

  const toggleModifier = useCallback((code: string) => {
    const current = stickyRef.current[code];
    const next = nextStickyState(current);
    if (current === undefined) window.api.sendKey({ code, pressed: true });
    if (next === undefined) window.api.sendKey({ code, pressed: false });

    const updated = { ...stickyRef.current };
    if (next === undefined) delete updated[code];
    else updated[code] = next;
    setSticky(updated);
  }, []);

  const handleKeyDown = useCallback(
    (key: VKey) => {
      if (!enabled) return;
      if (isModifierKey(key.code)) {
        toggleModifier(key.code);
        return;
      }
      tap(key.code);
      // Auto-repeat: navigating a BIOS menu would otherwise mean dozens of
      // clicks on the same arrow.
      stopRepeat();
      pressedCode.current = key.code;
      repeatTimers.current.delay = window.setTimeout(() => {
        repeatTimers.current.interval = window.setInterval(
          () => tap(key.code),
          REPEAT_INTERVAL_MS,
        );
      }, REPEAT_DELAY_MS);
    },
    [enabled, stopRepeat, tap, toggleModifier],
  );

  const handleKeyUp = useCallback(
    (key: VKey) => {
      if (pressedCode.current !== key.code) return;
      pressedCode.current = null;
      stopRepeat();
      // One-shot modifiers only drop after an ordinary key.
      releaseOneShots();
    },
    [releaseOneShots, stopRepeat],
  );

  /** A combination is sent whole, regardless of what is currently latched. */
  const sendCombo = useCallback(
    (keys: string[]) => {
      if (!enabled) return;
      for (const code of keys) window.api.sendKey({ code, pressed: true });
      for (const code of [...keys].reverse()) window.api.sendKey({ code, pressed: false });
    },
    [enabled],
  );

  const releaseAll = useCallback(() => {
    window.api.resetKeyboard();
    setSticky({});
  }, []);

  const shiftActive = sticky.ShiftLeft !== undefined || sticky.ShiftRight !== undefined;
  const heldCount = Object.keys(sticky).length;

  return (
    <div className="vkbd">
      <div className="vkbd__body">
        {BLOCKS.map((block) => (
          <div
            key={block.name}
            className="vkbd__block"
            style={{ width: `calc(var(--vkbd-u) * ${block.units})` }}
          >
            {block.rows.map((row, index) => (
              <div key={index} className="vkbd__row">
                {row.map((slot, slotIndex) => (
                  <Slot
                    key={slotIndex}
                    slot={slot}
                    enabled={enabled}
                    shiftActive={shiftActive}
                    sticky={sticky}
                    leds={leds}
                    onDown={handleKeyDown}
                    onUp={handleKeyUp}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="vkbd__footer">
        <span className="vkbd__label">{t('vkbd.combos')}</span>
        {COMBOS.map((combo) => (
          <button
            key={combo.label}
            type="button"
            className="vkey vkey--combo"
            title={t(combo.titleKey)}
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => sendCombo(combo.keys)}
          >
            {combo.label}
          </button>
        ))}

        <button
          type="button"
          className="vkey vkey--combo"
          disabled={!enabled || heldCount === 0}
          title={t('vkbd.releaseAllTitle')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={releaseAll}
        >
          {t('vkbd.releaseAll')}
        </button>

        <span className="vkbd__hint">{t('vkbd.hint')}</span>
      </div>
    </div>
  );
}

interface SlotProps {
  slot: VSlot;
  enabled: boolean;
  shiftActive: boolean;
  sticky: StickyMap;
  leds: number;
  onDown: (key: VKey) => void;
  onUp: (key: VKey) => void;
}

function Slot({ slot, enabled, shiftActive, sticky, leds, onDown, onUp }: SlotProps) {
  const { t } = useI18n();
  const width = `calc(var(--vkbd-u) * ${slotWidth(slot)})`;

  if (isGap(slot)) {
    return <span className="vkbd__slot" style={{ width }} />;
  }

  const state = sticky[slot.code];
  const ledBit = LedBit[slot.code];
  const ledOn = ledBit !== undefined && (leds & ledBit) !== 0;
  const label = shiftActive && slot.shift ? slot.shift : slot.label;
  // "PrtSc", "Pause" and "PgUp" do not fit a key of ordinary width.
  const tight = label.length >= 4 && (slot.width ?? 1) <= 1;

  const className = [
    'vkey',
    tight && 'vkey--tight',
    state === 'once' && 'vkey--once',
    state === 'lock' && 'vkey--lock',
    ledOn && 'vkey--led',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className="vkbd__slot" style={{ width }}>
      <button
        type="button"
        className={className}
        disabled={!enabled}
        title={slot.titleKey ? t(slot.titleKey) : slot.code}
        // The key must not take focus, or Space and Enter would keep
        // "pressing" the last button on the panel.
        onMouseDown={(event) => {
          event.preventDefault();
          onDown(slot);
        }}
        onMouseUp={() => onUp(slot)}
        onMouseLeave={() => onUp(slot)}
      >
        {label}
      </button>
    </span>
  );
}
