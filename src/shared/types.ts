import type { Message } from './i18n';
import type { AdvancedSettings } from './settings';

/** Types shared by main, preload and renderer. */

/** A saved BMC connection profile. The password lives separately, in safeStorage. */
export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  /** Port of the BMC web interface. */
  port: number;
  username: string;
  /** true — the password is kept in encrypted storage. */
  hasSavedPassword: boolean;
  /** Only the settings that differ from the defaults; absent when none do. */
  advanced?: Partial<AdvancedSettings>;
}

/** KVM session parameters taken from the JNLP after a web login. */
export interface KvmCredentials {
  host: string;
  /** Web session cookie, sent in the IVTP_GET_WEB_TOKEN packet. */
  webCookie: string;
  /** One-shot 16-character token, sent in IVTP_VALIDATE_VIDEO_SESSION. */
  kvmToken: string;
  kvmPort: number;
  /** 1 — the session runs over TLS. */
  kvmSecure: boolean;
  cdPort: number;
  fdPort: number;
  hdPort: number;
  userPrivileges: number;
}

/** An inclusive range of IPv4 addresses to sweep for BMCs. */
export interface ScanRange {
  from: string;
  to: string;
}

/** A BMC that answered a discovery request. */
export interface DiscoveredServer {
  host: string;
  /** The highest IPMI version the BMC reports support for. */
  ipmiVersion: '1.5' | '2.0';
  /** IANA enterprise number from the reply, 0 when none is reported. */
  oemId: number;
  /** Vendor name for a recognised OEM id, null otherwise. */
  vendor: string | null;
}

export type MouseMode = 'relative' | 'absolute' | 'other';

export type PowerCommand =
  | 'off-immediate'
  | 'on'
  | 'cycle'
  | 'hard-reset'
  | 'orderly-shutdown';

export type KvmStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'authenticating' }
  | { kind: 'connected' }
  /** Already translated by the renderer that caught the error. */
  | { kind: 'error'; message: string }
  | { kind: 'closed'; reason: Message };

/** Video frame header (13 bytes at the start of an assembled frame). */
export interface FrameHeader {
  flags: number;
  frameSize: number;
  /** Visible width — the size of the resulting raster. */
  resX: number;
  resY: number;
  /** Width inside the decoder stream, may exceed resX. */
  actResX: number;
  actResY: number;
}

/** Events main sends to the renderer. */
export interface KvmEvents {
  status: KvmStatus;
  /** An assembled compressed frame (header + data), decoded in a worker. */
  frame: ArrayBuffer;
  /** false — the server stopped producing video, true — frames are arriving. */
  videoSignal: boolean;
  powerStatus: boolean;
  powerResponse: { ok: boolean; code: number };
  mouseMode: MouseMode;
  /** Bit mask: 1 — NumLock, 2 — CapsLock, 4 — ScrollLock. */
  keyboardLeds: number;
  activeClients: string[];
}

export type KvmEventName = keyof KvmEvents;

/** A single IPMI sensor reading. */
export interface IpmiSensor {
  id: number;
  name: string;
  /** null — the sensor is discrete, or the reading is unavailable. */
  value: number | null;
  /** Unit code ('C', 'V', 'RPM', …), translated in the renderer. */
  unit: string;
  discrete: boolean;
  /** Translation keys of the active threshold states (threshold sensors only). */
  states: string[];
  ok: boolean;
}

/** A system event log record. */
export interface IpmiSelEntry {
  id: number;
  /** ISO string, or null for records without a timestamp. */
  timestamp: string | null;
  sensorType: number;
  sensorNumber: number;
  direction: 'assert' | 'deassert';
}

/** The full state snapshot rendered by the IPMI panel. */
export interface IpmiSnapshot {
  device: {
    firmwareVersion: string;
    ipmiVersion: string;
    manufacturerId: number;
    productId: number;
  };
  chassis: {
    powerOn: boolean;
    /** Translation key of the last power event. */
    lastPowerEvent: string;
    /** Translation key of the power restore policy. */
    powerRestorePolicy: string;
    identifyActive: boolean;
    powerFault: boolean;
    powerOverload: boolean;
    coolingFault: boolean;
    driveFault: boolean;
    chassisIntrusion: boolean;
  };
  sensors: IpmiSensor[];
  selCount: number;
  sel: IpmiSelEntry[];
}

/**
 * How an image is presented to the server.
 *
 * The BMC keeps a separate service, and a separate port, for each: an image
 * mounted as a CD-ROM appears to the BIOS as an optical drive, one mounted as
 * a hard disk as a USB stick. Hybrid images (most Linux installers) boot
 * either way; a plain ISO only as a CD-ROM.
 */
export type VirtualMediaKind = 'cdrom' | 'harddisk';

/** Which of the media services the BMC actually offers. */
export interface VirtualMediaServices {
  cdrom: boolean;
  harddisk: boolean;
}

/** Virtual media state. */
export interface VirtualMediaState {
  mounted: boolean;
  isoPath?: string;
  kind?: VirtualMediaKind;
  /** How many bytes of the image have been served to the server. */
  bytesServed?: number;
  /** The guest system asked for the disk to be ejected. */
  ejectedByGuest?: boolean;
  lastError?: Message;
}

/** A key press or release, sent from the renderer to main. */
export interface KeyEventPayload {
  /** KeyboardEvent.code, for example "KeyA", "F1", "ArrowRight". */
  code: string;
  pressed: boolean;
}

/** Mouse state, sent from the renderer to main. */
export interface MouseEventPayload {
  /** Coordinates in pixels of the visible raster. */
  x: number;
  y: number;
  /** Button bit mask: 1 — left, 2 — right, 4 — middle. */
  buttons: number;
  /** -1, 0 or 1. */
  wheel: number;
}
