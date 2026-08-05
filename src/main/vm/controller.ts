import type { BrowserWindow } from 'electron';
import type { VirtualMediaState } from '@shared/types';
import { IpcChannel } from '@shared/ipc';
import { AppError } from '@shared/i18n';
import { VirtualMediaSession } from './session';

/**
 * Mounts an ISO as a virtual CD-ROM and reports the state to the renderer.
 */
export class VirtualMediaController {
  private session: VirtualMediaSession | null = null;
  private state: VirtualMediaState = { mounted: false };

  constructor(
    private readonly window: BrowserWindow,
    private readonly connection: { host: string; cdPort: number; token: string },
    /** The BMC is told about media state changes over the KVM channel. */
    private readonly notifyMediaState: (attached: boolean) => void,
  ) {}

  get current(): VirtualMediaState {
    return this.state;
  }

  /** Mounts an image and waits for SCSI requests from the BMC. */
  async mount(isoPath: string): Promise<void> {
    this.unmount();

    const session = new VirtualMediaSession({
      host: this.connection.host,
      port: this.connection.cdPort,
      token: this.connection.token,
      isoPath,
    });
    this.session = session;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError('vm.noAck')), 15_000);

      session.once('ready', () => {
        clearTimeout(timer);
        // The BMC only shows the medium to the guest after this packet.
        this.notifyMediaState(true);
        this.update({ mounted: true, isoPath, bytesServed: 0 });
        resolve();
      });
      session.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      session.once('closed', (reason) => {
        clearTimeout(timer);
        // The rejection travels through IPC, where only the text survives —
        // encode the key so the renderer can translate it back.
        reject(new AppError(reason.key, reason.params));
      });

      session.connect();
    });

    // Later events no longer affect the outcome of mounting.
    session.on('progress', (bytes) => {
      this.update({ ...this.state, bytesServed: bytes });
    });
    session.on('ejected', () => {
      this.update({ ...this.state, ejectedByGuest: true });
    });
    session.on('closed', (reason) => {
      this.session = null;
      this.notifyMediaState(false);
      this.update({ mounted: false, lastError: reason });
    });
  }

  unmount(): void {
    if (!this.session) return;
    this.session.removeAllListeners();
    this.session.close();
    this.session = null;
    this.notifyMediaState(false);
    this.update({ mounted: false });
  }

  private update(state: VirtualMediaState): void {
    this.state = state;
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IpcChannel.KvmEvent, { type: 'virtualMedia', state });
  }
}
