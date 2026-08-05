import type { Locale } from './i18n';
import type {
  IpmiSnapshot,
  KeyEventPayload,
  KvmStatus,
  MouseEventPayload,
  MouseMode,
  PowerCommand,
  ServerProfile,
  VirtualMediaState,
} from './types';

/** The IPC contract between renderer and main. */

export interface ConnectRequest {
  host: string;
  /** Port of the BMC web interface. */
  port: number;
  username: string;
  password: string;
}

export interface SaveServerRequest {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** An empty string deletes the stored password, undefined leaves it as is. */
  password?: string;
}

/** Messages from main to renderer. */
export type KvmEvent =
  | { type: 'status'; status: KvmStatus }
  | { type: 'blankScreen' }
  | { type: 'powerStatus'; on: boolean }
  | { type: 'powerResponse'; ok: boolean; code: number }
  | { type: 'mouseMode'; mode: MouseMode }
  | { type: 'keyboardLeds'; leds: number }
  | { type: 'activeClients'; clients: string[] }
  | { type: 'virtualMedia'; state: VirtualMediaState };

export const IpcChannel = {
  ServersList: 'servers:list',
  ServersSave: 'servers:save',
  ServersDelete: 'servers:delete',
  ServersPassword: 'servers:password',
  ServersCanStorePasswords: 'servers:can-store-passwords',
  AppSetLocale: 'app:set-locale',
  KvmConnect: 'kvm:connect',
  KvmDisconnect: 'kvm:disconnect',
  KvmPower: 'kvm:power',
  KvmRefresh: 'kvm:refresh',
  KvmSetMouseMode: 'kvm:set-mouse-mode',
  KvmKey: 'kvm:key',
  KvmMouse: 'kvm:mouse',
  KvmResetKeyboard: 'kvm:reset-keyboard',
  KvmSendCtrlAltDel: 'kvm:ctrl-alt-del',
  IpmiSnapshot: 'ipmi:snapshot',
  VmChooseIso: 'vm:choose-iso',
  VmMount: 'vm:mount',
  VmUnmount: 'vm:unmount',
  /** main -> renderer: control events. */
  KvmEvent: 'kvm:event',
  /** main -> renderer: a compressed video frame. */
  KvmFrame: 'kvm:frame',
} as const;

/** The API preload exposes to the renderer. */
export interface IpcApi {
  listServers(): Promise<ServerProfile[]>;
  saveServer(request: SaveServerRequest): Promise<ServerProfile>;
  deleteServer(id: string): Promise<void>;
  getServerPassword(id: string): Promise<string | null>;
  canStorePasswords(): Promise<boolean>;

  /** Tells main which language to use for native dialogs. */
  setLocale(locale: Locale): void;

  connect(request: ConnectRequest): Promise<void>;
  disconnect(): Promise<void>;
  sendPower(command: PowerCommand): Promise<void>;
  refreshScreen(): Promise<void>;
  setMouseMode(mode: MouseMode): Promise<void>;
  sendKey(payload: KeyEventPayload): void;
  sendMouse(payload: MouseEventPayload & { screenWidth: number; screenHeight: number }): void;
  resetKeyboard(): void;
  sendCtrlAltDel(): Promise<void>;

  /** Reads sensors, chassis state and the event log over IPMI over LAN. */
  fetchIpmiSnapshot(): Promise<IpmiSnapshot>;

  /** Opens the native ISO picker. Returns null when cancelled. */
  chooseIso(): Promise<string | null>;
  /** Mounts an image as a virtual CD-ROM. */
  mountIso(isoPath: string): Promise<void>;
  unmountIso(): Promise<void>;

  onEvent(listener: (event: KvmEvent) => void): () => void;
  onFrame(listener: (frame: ArrayBuffer) => void): () => void;
}
