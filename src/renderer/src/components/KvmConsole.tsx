import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseMode } from '@shared/types';
import type { DecoderResponse } from '../kvm/decoder.worker';
import { useI18n } from '../i18n';

/**
 * The remote console screen.
 *
 * The canvas is handed to a worker through transferControlToOffscreen:
 * compressed frames arrive from main and are decoded off the main thread, so
 * the UI does not stutter on full frames.
 */

interface Props {
  mouseMode: MouseMode;
  /** Whether to capture the keyboard and mouse. */
  inputEnabled: boolean;
  /** At most one movement packet per interval — as in the original client. */
  mouseThrottleMs: number;
  onNeedFullScreen: () => void;
}

export function KvmConsole({
  mouseMode,
  inputEnabled,
  mouseThrottleMs,
  onNeedFullScreen,
}: Props) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const transferredRef = useRef(false);

  const [resolution, setResolution] = useState({ width: 0, height: 0 });
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;

  // The last mouse position sent — needed to throttle movement.
  const pendingMouse = useRef<{ x: number; y: number; buttons: number } | null>(null);
  const lastMouseSent = useRef(0);
  const relativeAnchor = useRef<{ x: number; y: number } | null>(null);

  const onNeedFullScreenRef = useRef(onNeedFullScreen);
  onNeedFullScreenRef.current = onNeedFullScreen;

  // The worker is created once for the lifetime of the component.
  useEffect(() => {
    const worker = new Worker(new URL('../kvm/decoder.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      const message = event.data;
      if (message.type === 'resolution') {
        setResolution({ width: message.width, height: message.height });
      } else if (message.type === 'needFullScreen') {
        console.warn('The decoder asked for a full frame:', message.reason);
        onNeedFullScreenRef.current();
      }
    };

    const canvas = canvasRef.current;
    if (canvas && !transferredRef.current) {
      transferredRef.current = true;
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    }

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Frames from main go straight to the worker.
  useEffect(() => {
    return window.api.onFrame((frame) => {
      workerRef.current?.postMessage({ type: 'frame', frame }, [frame]);
    });
  }, []);

  /**
   * Converts cursor coordinates into raster pixels.
   *
   * The canvas is stretched with object-fit: contain, so one axis is padded
   * inside the element; that padding has to be subtracted or the cursor
   * misses its target.
   */
  const toScreenCoords = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const { width, height } = resolutionRef.current;
    if (!canvas || width === 0 || height === 0) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const scale = Math.min(rect.width / width, rect.height / height);
    const offsetX = (rect.width - width * scale) / 2;
    const offsetY = (rect.height - height * scale) / 2;

    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;
    return {
      x: Math.max(0, Math.min(width, Math.round(x))),
      y: Math.max(0, Math.min(height, Math.round(y))),
    };
  }, []);

  const sendMouse = useCallback(
    (x: number, y: number, buttons: number, wheel: number) => {
      const { width, height } = resolutionRef.current;
      if (width === 0) return;

      if (mouseMode === 'relative') {
        // In relative mode the server receives a delta, not a position.
        const anchor = relativeAnchor.current ?? { x, y };
        relativeAnchor.current = { x, y };
        window.api.sendMouse({
          x: x - anchor.x,
          y: y - anchor.y,
          buttons,
          wheel,
          screenWidth: width,
          screenHeight: height,
        });
        return;
      }

      window.api.sendMouse({ x, y, buttons, wheel, screenWidth: width, screenHeight: height });
    },
    [mouseMode],
  );

  // Mouse movement arrives dozens of times per second — thin it out.
  useEffect(() => {
    if (!inputEnabled) return;
    const timer = setInterval(() => {
      const pending = pendingMouse.current;
      if (!pending) return;
      pendingMouse.current = null;
      lastMouseSent.current = Date.now();
      sendMouse(pending.x, pending.y, pending.buttons, 0);
    }, mouseThrottleMs);
    return () => clearInterval(timer);
  }, [inputEnabled, mouseThrottleMs, sendMouse]);

  // The keyboard is listened for on the window, to catch arrows and function keys.
  useEffect(() => {
    if (!inputEnabled) return;

    const onKey = (event: KeyboardEvent) => {
      // Leave the user a way out of full screen and out of the window.
      if (event.key === 'Escape' && event.shiftKey) return;
      event.preventDefault();
      window.api.sendKey({ code: event.code, pressed: event.type === 'keydown' });
    };

    const onBlur = () => window.api.resetKeyboard();

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      window.api.resetKeyboard();
    };
  }, [inputEnabled]);

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    const coords = toScreenCoords(event);
    if (!coords) return;
    pendingMouse.current = { ...coords, buttons: toButtonMask(event.buttons) };
  };

  const handleMouseButton = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    event.preventDefault();
    const coords = toScreenCoords(event);
    if (!coords) return;
    // Clicks are sent immediately, bypassing the throttle.
    pendingMouse.current = null;
    sendMouse(coords.x, coords.y, toButtonMask(event.buttons), 0);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    const coords = toScreenCoords(event);
    if (!coords) return;
    sendMouse(coords.x, coords.y, toButtonMask(event.buttons), event.deltaY > 0 ? -1 : 1);
  };

  const hasImage = resolution.width > 0;

  return (
    <div className="console">
      <canvas
        ref={canvasRef}
        className="console__canvas"
        style={{ visibility: hasImage ? 'visible' : 'hidden' }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseButton}
        onMouseUp={handleMouseButton}
        onWheel={handleWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      {!hasImage && <div className="console__placeholder">{t('console.waiting')}</div>}
    </div>
  );
}

/**
 * The low three bits of MouseEvent.buttons match USB HID (left/right/middle);
 * the higher ones are the forward and back buttons, which the emulated mouse
 * does not have.
 */
function toButtonMask(buttons: number): number {
  return buttons & 0b111;
}
