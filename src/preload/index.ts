import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DiscoveredServer,
  IpmiSnapshot,
  KeyEventPayload,
  MouseMode,
  PowerCommand,
  ScanRange,
  ServerProfile,
  VirtualMediaKind,
} from '@shared/types';
import type { Locale } from '@shared/i18n';
import {
  IpcChannel,
  type ConnectRequest,
  type IpcApi,
  type KvmEvent,
  type SaveServerRequest,
  type ScanProgress,
} from '@shared/ipc';

/**
 * The bridge into the renderer. The renderer runs without nodeIntegration, so
 * every access to the network and the filesystem goes through the methods
 * listed here and nowhere else.
 */
const api: IpcApi = {
  listServers: () => ipcRenderer.invoke(IpcChannel.ServersList) as Promise<ServerProfile[]>,
  saveServer: (request: SaveServerRequest) =>
    ipcRenderer.invoke(IpcChannel.ServersSave, request) as Promise<ServerProfile>,
  deleteServer: (id: string) => ipcRenderer.invoke(IpcChannel.ServersDelete, id) as Promise<void>,
  getServerPassword: (id: string) =>
    ipcRenderer.invoke(IpcChannel.ServersPassword, id) as Promise<string | null>,
  canStorePasswords: () =>
    ipcRenderer.invoke(IpcChannel.ServersCanStorePasswords) as Promise<boolean>,

  setLocale: (locale: Locale) => ipcRenderer.send(IpcChannel.AppSetLocale, locale),

  getLocalScanRange: () =>
    ipcRenderer.invoke(IpcChannel.ScanLocalRange) as Promise<ScanRange | null>,
  scanNetwork: (range: ScanRange) =>
    ipcRenderer.invoke(IpcChannel.ScanStart, range) as Promise<DiscoveredServer[]>,
  cancelScan: () => ipcRenderer.invoke(IpcChannel.ScanCancel) as Promise<void>,

  onScanProgress: (listener: (progress: ScanProgress) => void) => {
    const handler = (_event: IpcRendererEvent, payload: ScanProgress) => listener(payload);
    ipcRenderer.on(IpcChannel.ScanProgress, handler);
    return () => ipcRenderer.off(IpcChannel.ScanProgress, handler);
  },

  connect: (request: ConnectRequest) =>
    ipcRenderer.invoke(IpcChannel.KvmConnect, request) as Promise<void>,
  disconnect: () => ipcRenderer.invoke(IpcChannel.KvmDisconnect) as Promise<void>,
  sendPower: (command: PowerCommand) =>
    ipcRenderer.invoke(IpcChannel.KvmPower, command) as Promise<void>,
  refreshScreen: () => ipcRenderer.invoke(IpcChannel.KvmRefresh) as Promise<void>,
  setMouseMode: (mode: MouseMode) =>
    ipcRenderer.invoke(IpcChannel.KvmSetMouseMode, mode) as Promise<void>,
  sendCtrlAltDel: () => ipcRenderer.invoke(IpcChannel.KvmSendCtrlAltDel) as Promise<void>,
  fetchIpmiSnapshot: () => ipcRenderer.invoke(IpcChannel.IpmiSnapshot) as Promise<IpmiSnapshot>,

  chooseIso: () => ipcRenderer.invoke(IpcChannel.VmChooseIso) as Promise<string | null>,
  mountIso: (isoPath: string, kind: VirtualMediaKind) =>
    ipcRenderer.invoke(IpcChannel.VmMount, isoPath, kind) as Promise<void>,
  unmountIso: () => ipcRenderer.invoke(IpcChannel.VmUnmount) as Promise<void>,

  sendKey: (payload: KeyEventPayload) => ipcRenderer.send(IpcChannel.KvmKey, payload),
  sendMouse: (payload) => ipcRenderer.send(IpcChannel.KvmMouse, payload),
  resetKeyboard: () => ipcRenderer.send(IpcChannel.KvmResetKeyboard),

  onEvent: (listener: (event: KvmEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: KvmEvent) => listener(payload);
    ipcRenderer.on(IpcChannel.KvmEvent, handler);
    return () => ipcRenderer.off(IpcChannel.KvmEvent, handler);
  },

  onFrame: (listener: (frame: ArrayBuffer) => void) => {
    const handler = (_event: IpcRendererEvent, frame: ArrayBuffer) => listener(frame);
    ipcRenderer.on(IpcChannel.KvmFrame, handler);
    return () => ipcRenderer.off(IpcChannel.KvmFrame, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
