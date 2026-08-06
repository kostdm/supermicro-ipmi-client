import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, safeStorage } from 'electron';
import type { ServerProfile } from '@shared/types';

/**
 * The list of BMCs and their passwords.
 *
 * Profiles live as plain JSON in userData; passwords live in a separate file,
 * each encrypted through safeStorage (Keychain on macOS, DPAPI on Windows).
 * When the system offers no encryption, passwords are simply not saved —
 * writing them to disk in the clear is not an option.
 */

interface StoredProfile extends ServerProfile {}

interface StoreShape {
  version: 1;
  servers: StoredProfile[];
}

let cache: StoreShape | null = null;

function profilesPath(): string {
  return join(app.getPath('userData'), 'servers.json');
}

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json');
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function load(): StoreShape {
  if (!cache) cache = readJson<StoreShape>(profilesPath(), { version: 1, servers: [] });
  return cache;
}

function save(): void {
  if (cache) writeJson(profilesPath(), cache);
}

/** Passwords: profile id -> base64 of the encrypted value. */
function loadSecrets(): Record<string, string> {
  return readJson<Record<string, string>>(secretsPath(), {});
}

export function listServers(): ServerProfile[] {
  return load().servers;
}

export function upsertServer(
  input: Omit<ServerProfile, 'id' | 'hasSavedPassword'> & { id?: string },
  password?: string,
): ServerProfile {
  const store = load();
  const id = input.id ?? randomUUID();

  if (password !== undefined) {
    const secrets = loadSecrets();
    if (password === '') {
      delete secrets[id];
    } else if (safeStorage.isEncryptionAvailable()) {
      secrets[id] = safeStorage.encryptString(password).toString('base64');
    }
    writeJson(secretsPath(), secrets);
  }

  const profile: ServerProfile = {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    hasSavedPassword: Boolean(loadSecrets()[id]),
  };
  // A profile on the defaults carries no advanced block at all, so a default
  // that changes later applies to it.
  if (input.advanced && Object.keys(input.advanced).length > 0) {
    profile.advanced = input.advanced;
  }

  const index = store.servers.findIndex((s) => s.id === id);
  if (index >= 0) store.servers[index] = profile;
  else store.servers.push(profile);
  save();
  return profile;
}

export function deleteServer(id: string): void {
  const store = load();
  store.servers = store.servers.filter((s) => s.id !== id);
  save();

  const secrets = loadSecrets();
  delete secrets[id];
  writeJson(secretsPath(), secrets);
}

/** Returns the stored password, or null if there is none or it will not decrypt. */
export function getPassword(id: string): string | null {
  const encrypted = loadSecrets()[id];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

/** Whether this system can store passwords securely. */
export function canStorePasswords(): boolean {
  return safeStorage.isEncryptionAvailable();
}
