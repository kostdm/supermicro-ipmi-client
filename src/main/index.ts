import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type {
  DiscoveredServer,
  KeyEventPayload,
  MouseMode,
  PowerCommand,
  ScanRange,
  VirtualMediaKind,
} from '@shared/types';
import { IpcChannel, type ConnectRequest, type SaveServerRequest } from '@shared/ipc';
import { AppError, DEFAULT_LOCALE, isLocale, pickLocale, translate, type Locale } from '@shared/i18n';
import {
  canStorePasswords,
  deleteServer,
  getPassword,
  listServers,
  upsertServer,
} from './store/servers';
import { KvmController } from './kvm/controller';
import { IpmiController } from './ipmi/controller';
import { VirtualMediaController } from './vm/controller';
import { NetworkScanner, localScanRange } from './net/discover';

let mainWindow: BrowserWindow | null = null;
let controller: KvmController | null = null;
/** The IPMI session runs alongside KVM and uses the same credentials. */
let ipmi: IpmiController | null = null;
let virtualMedia: VirtualMediaController | null = null;
/** At most one scan at a time: a second one would only share the airtime. */
let scanner: NetworkScanner | null = null;

/**
 * Language of the native dialogs. The renderer owns the choice and pushes it
 * here; until then the system locale is the best guess available.
 */
let locale: Locale = DEFAULT_LOCALE;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14161a',
    title: 'Supermicro IPMI Client',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  controller = new KvmController(mainWindow);

  // An application menu would intercept Alt and F10 before the console does.
  Menu.setApplicationMenu(null);

  /*
   * Chromium handles some keys itself (F12 and Ctrl+Shift+I open the developer
   * tools, Ctrl+R reloads the page) and they never reach the renderer's
   * handler. Suppress them here: in a KVM console all of that belongs to the
   * remote server.
   */
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const isDevTools =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    const isReload =
      (input.control || input.meta) && input.key.toLowerCase() === 'r';

    if (isDevTools || isReload) event.preventDefault();
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // External links open in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.ServersList, () => listServers());
  ipcMain.handle(IpcChannel.ServersSave, (_event, request: SaveServerRequest) =>
    upsertServer(
      {
        id: request.id,
        name: request.name,
        host: request.host,
        port: request.port,
        username: request.username,
        advanced: request.advanced,
      },
      request.password,
    ),
  );
  ipcMain.handle(IpcChannel.ServersDelete, (_event, id: string) => deleteServer(id));
  ipcMain.handle(IpcChannel.ServersPassword, (_event, id: string) => getPassword(id));
  ipcMain.handle(IpcChannel.ServersCanStorePasswords, () => canStorePasswords());

  ipcMain.on(IpcChannel.AppSetLocale, (_event, value: unknown) => {
    if (isLocale(value)) locale = value;
  });

  ipcMain.handle(IpcChannel.ScanLocalRange, () => localScanRange());

  ipcMain.handle(IpcChannel.ScanStart, async (_event, range: ScanRange) => {
    scanner?.cancel();
    const current = new NetworkScanner();
    scanner = current;

    const found: DiscoveredServer[] = [];
    // Replies arrive out of step with the sweep, so the last known position is
    // kept and resent whenever a BMC answers.
    let scanned = 0;
    let total = 0;

    const report = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IpcChannel.ScanProgress, { scanned, total, found });
    };

    try {
      return await current.scan(range, {
        onFound: (server) => {
          found.push(server);
          report();
        },
        onProgress: (done, size) => {
          scanned = done;
          total = size;
          report();
        },
      });
    } finally {
      if (scanner === current) scanner = null;
    }
  });

  ipcMain.handle(IpcChannel.ScanCancel, () => {
    scanner?.cancel();
    scanner = null;
  });

  ipcMain.handle(IpcChannel.KvmConnect, async (_event, request: ConnectRequest) => {
    await controller?.connect(request);
    ipmi?.close();
    ipmi = new IpmiController(
      request.host,
      request.username,
      request.password,
      request.advanced,
    );
    // Power control runs over IPMI, so the KVM controller needs this session.
    controller?.useIpmi(ipmi);
    // The chassis state is worth having even when the KVM session never comes
    // up: the power badge is then the one thing on screen that still means
    // something.
    void controller?.refreshPowerState();
  });
  ipcMain.handle(IpcChannel.KvmDisconnect, async () => {
    virtualMedia?.unmount();
    virtualMedia = null;
    controller?.useIpmi(null);
    ipmi?.close();
    ipmi = null;
    await controller?.disconnect();
  });
  ipcMain.handle(IpcChannel.IpmiSnapshot, async () => {
    if (!ipmi) throw new AppError('error.noConnection');
    return ipmi.snapshot();
  });

  ipcMain.handle(IpcChannel.VmChooseIso, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: translate(locale, 'dialog.chooseIso'),
      properties: ['openFile'],
      filters: [{ name: translate(locale, 'dialog.diskImages'), extensions: ['iso', 'img'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    IpcChannel.VmMount,
    async (_event, isoPath: string, kind: VirtualMediaKind = 'cdrom') => {
      if (!controller || !mainWindow) throw new AppError('error.noConnection');
      const connection = controller.connectionInfo;
      if (!connection) throw new AppError('error.noKvmSession');
      if (!controller.mediaServices[kind]) {
        throw new AppError(
          kind === 'cdrom' ? 'error.cdServiceUnavailable' : 'error.hdServiceUnavailable',
        );
      }

      virtualMedia?.unmount();
      virtualMedia = new VirtualMediaController(mainWindow, connection, (attached) =>
        controller?.notifyMediaState(attached),
      );
      await virtualMedia.mount(isoPath, kind);
    },
  );

  ipcMain.handle(IpcChannel.VmUnmount, () => {
    virtualMedia?.unmount();
    virtualMedia = null;
  });
  ipcMain.handle(IpcChannel.KvmPower, async (_event, command: PowerCommand) => {
    if (!controller) throw new AppError('error.noConnection');
    await controller.sendPower(command);
  });
  ipcMain.handle(IpcChannel.KvmRefresh, () => controller?.refreshScreen());
  ipcMain.handle(IpcChannel.KvmSetMouseMode, (_event, mode: MouseMode) =>
    controller?.setMouseMode(mode),
  );
  ipcMain.handle(IpcChannel.KvmSendCtrlAltDel, () => controller?.sendCtrlAltDel());

  // Input is a stream — send instead of invoke, so no event waits for a reply.
  ipcMain.on(IpcChannel.KvmKey, (_event, payload: KeyEventPayload) =>
    controller?.sendKey(payload),
  );
  ipcMain.on(
    IpcChannel.KvmMouse,
    (
      _event,
      payload: {
        x: number;
        y: number;
        buttons: number;
        wheel: number;
        screenWidth: number;
        screenHeight: number;
      },
    ) => controller?.sendMouse(payload, payload.screenWidth, payload.screenHeight),
  );
  ipcMain.on(IpcChannel.KvmResetKeyboard, () => controller?.resetKeyboard());
}

app.whenReady().then(() => {
  // A first guess before the renderer reports the language it settled on.
  locale = pickLocale([app.getLocale()]);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scanner?.cancel();
  virtualMedia?.unmount();
  ipmi?.close();
  void controller?.disconnect();
});
