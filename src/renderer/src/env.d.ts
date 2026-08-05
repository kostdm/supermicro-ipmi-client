/// <reference types="vite/client" />
import type { IpcApi } from '@shared/ipc';

declare global {
  interface Window {
    /** The bridge into the main process, exported from preload. */
    api: IpcApi;
  }
}

export {};
