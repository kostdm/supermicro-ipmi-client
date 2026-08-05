/// <reference lib="webworker" />
import { AvicaDecoder, DecodeError } from '@shared/avica';

/**
 * Video decoding on a thread of its own.
 *
 * main sends a compressed frame (~20 KB) — handing over an already decoded
 * raster would cost two orders of magnitude more. Drawing goes straight into
 * an OffscreenCanvas so the pixels never travel back to the main thread.
 */

export type DecoderRequest =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'frame'; frame: ArrayBuffer }
  | { type: 'reset' };

export type DecoderResponse =
  | { type: 'resolution'; width: number; height: number }
  | { type: 'rendered'; width: number; height: number }
  | { type: 'needFullScreen'; reason: string };

const decoder = new AvicaDecoder();
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let imageData: ImageData | null = null;

function ensureSurface(width: number, height: number): void {
  if (!canvas || !ctx) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    imageData = null;
  }
  if (!imageData || imageData.width !== width || imageData.height !== height) {
    imageData = ctx.createImageData(width, height);
  }
}

function post(message: DecoderResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<DecoderRequest>) => {
  const message = event.data;

  switch (message.type) {
    case 'init': {
      canvas = message.canvas;
      ctx = canvas.getContext('2d');
      if (!ctx) post({ type: 'needFullScreen', reason: 'could not obtain a 2D context' });
      break;
    }

    case 'reset': {
      decoder.markCorrupted();
      break;
    }

    case 'frame': {
      if (!ctx) return;
      try {
        const decoded = decoder.decode(new Uint8Array(message.frame));
        ensureSurface(decoded.width, decoded.height);
        if (!imageData) return;

        imageData.data.set(decoded.pixels);
        ctx.putImageData(imageData, 0, 0);

        if (decoded.resolutionChanged) {
          post({ type: 'resolution', width: decoded.width, height: decoded.height });
        }
        post({ type: 'rendered', width: decoded.width, height: decoded.height });
      } catch (err) {
        const reason = err instanceof DecodeError ? err.message : String(err);
        post({ type: 'needFullScreen', reason });
      }
      break;
    }
  }
};
