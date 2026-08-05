/**
 * Interface translations, shared by main and renderer.
 *
 * The main process never produces user-facing prose. It emits message keys —
 * either as a `Message` inside an IPC event, or encoded into `Error.message`
 * for anything thrown across an `ipcMain.handle` boundary. The renderer picks
 * the language, so switching it retranslates text that already exists on
 * screen instead of leaving stale prose from an earlier session.
 *
 * Deliberately dependency-free: the project ships zero runtime dependencies,
 * and a flat key/value map is enough for two languages.
 */

export const LOCALES = ['en', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** A translatable string plus the values interpolated into it. */
export interface Message {
  key: string;
  params?: Record<string, string | number>;
}

export function msg(key: string, params?: Record<string, string | number>): Message {
  return params ? { key, params } : { key };
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks a supported language from a list of BCP 47 tags, most preferred
 * first. `en-GB` matches `en`; anything unrecognised falls back to English.
 */
export function pickLocale(candidates: readonly string[]): Locale {
  for (const tag of candidates) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

const EN: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.retry': 'Retry',
  'common.execute': 'Proceed',
  'common.language': 'Language',

  'servers.title': 'Servers',
  'servers.add': 'Add server',
  'servers.empty': 'Nothing here yet. Press “Add server” to enter a BMC address.',
  'servers.passwordSaved': 'password saved',
  'servers.connect': 'Connect',
  'servers.edit': 'Edit',
  'servers.delete': 'Delete',
  'servers.editTitle': 'Edit server',
  'servers.newTitle': 'New server',
  'servers.name': 'Name',
  'servers.namePlaceholder': 'node-01, for example',
  'servers.host': 'BMC address',
  'servers.port': 'Web interface port',
  'servers.user': 'User',
  'servers.password': 'Password',
  'servers.passwordStored': '(kept in the OS keychain)',
  'servers.passwordKeep': 'leave empty to keep the current one',
  'servers.noSecureStorage':
    'This system offers no secure storage — the password will not be saved.',
  'servers.passwordFor': 'Password for {name}',
  'servers.passwordForUser': 'Password for user {user}',

  'toolbar.disconnect': '← Disconnect',
  'toolbar.ctrlAltDel': 'Ctrl+Alt+Del',
  'toolbar.keyboard': '⌨ Keyboard',
  'toolbar.keyboardTitle': 'On-screen keyboard: clicks that bypass the host keyboard',
  'toolbar.refresh': 'Refresh screen',
  'toolbar.mountIso': 'Mount ISO',
  'toolbar.unmountIso': '💿 Eject image',
  'toolbar.mountedTitle': 'Mounted image: {path}',
  'toolbar.powerMenu': 'Power ▾',
  'toolbar.sessions': 'sessions: {count}',
  'toolbar.mouseMode': 'Mouse mode',

  'tabs.console': 'Console',
  'tabs.sensors': 'Sensors',

  'badge.powerUnknown': 'power: —',
  'badge.powerOn': 'power: on',
  'badge.powerOff': 'power: off',

  'mouse.absolute': 'Mouse: absolute',
  'mouse.relative': 'Mouse: relative',
  'mouse.other': 'Mouse: other mode',

  'power.on': 'Power on',
  'power.orderly-shutdown': 'Graceful shutdown (ACPI)',
  'power.hard-reset': 'Hard reset',
  'power.cycle': 'Power cycle',
  'power.off-immediate': 'Power off immediately',

  'confirm.title': 'Confirm the action',
  'confirm.body':
    '{action} — this affects a running system and may lead to data loss.',

  'notice.powerOk': 'Power command executed',
  'notice.powerRejected': 'The BMC rejected the power command (code {code})',
  'notice.noVideo': 'The server is not producing a video signal',
  'notice.mediaEjected': 'The server ejected the virtual disk',
  'notice.isoMounted': 'Image mounted. Reboot the server for the system to see it.',
  'notice.isoMountFailed': 'Could not mount the image: {error}',
  'notice.isoUnmounted': 'Image ejected',

  'status.connecting': 'Connecting to the BMC…',
  'status.authenticating': 'Authenticating the KVM session…',

  'console.waiting': 'Waiting for a video signal…',

  'vkbd.combos': 'Combinations',
  'vkbd.releaseAll': 'Release all',
  'vkbd.releaseAllTitle': 'Release every latched modifier',
  'vkbd.hint':
    'Clicking Ctrl, Shift, Alt or Win holds the modifier until the next key; ' +
    'clicking again holds it until you release it. The physical keyboard keeps working.',
  'vkbd.win': 'Windows / Command key',
  'vkbd.menu': 'Context menu',
  'vkbd.space': 'Space',
  'vkbd.backspace': 'Backspace',
  'vkbd.capsLock': 'Caps Lock',
  'combo.ctrlAltDel': 'Reboot or the security screen in the guest system',
  'combo.altTab': 'Switch windows in the guest system',
  'combo.altF4': 'Close the window in the guest system',
  'combo.ctrlEsc': 'Open the Start menu',
  'combo.winR': 'The Run dialog',
  'combo.ctrlShiftEsc': 'Task manager',

  'sensors.group.temperature': 'Temperature',
  'sensors.group.voltage': 'Voltage',
  'sensors.group.fans': 'Fans',
  'sensors.group.power': 'Power',
  'sensors.group.other': 'Other',
  'sensors.readFailed': 'Could not read IPMI data: {error}',
  'sensors.polling': 'Querying the BMC over IPMI…',
  'sensors.firmware': 'BMC firmware {version}',
  'sensors.ipmi': 'IPMI {version}',
  'sensors.chassisOn': 'Chassis: powered on',
  'sensors.chassisOff': 'Chassis: powered off',
  'sensors.lastEvent': 'Last event: {event}',
  'sensors.restorePolicy': 'On power restore: {policy}',
  'sensors.refresh': 'Refresh',
  'sensors.refreshing': 'Refreshing…',
  'sensors.lastPollFailed': 'The last poll failed: {error}',

  'fault.power': 'power fault',
  'fault.overload': 'power overload',
  'fault.cooling': 'cooling fault',
  'fault.drive': 'drive fault',
  'fault.intrusion': 'chassis intrusion',
  'fault.identify': 'identify LED active',

  'sel.title': 'Event log ({count})',
  'sel.empty': 'No entries.',
  'sel.noTimestamp': 'no timestamp',
  'sel.entry': 'sensor {number}, type 0x{type}',
  'sel.assert': 'asserted',
  'sel.deassert': 'deasserted',

  'unit.C': '°C',
  'unit.F': '°F',
  'unit.K': 'K',
  'unit.V': 'V',
  'unit.A': 'A',
  'unit.W': 'W',
  'unit.J': 'J',
  'unit.RPM': 'RPM',
  'unit.Hz': 'Hz',

  'restorePolicy.off': 'stay powered off',
  'restorePolicy.previous': 'restore the previous state',
  'restorePolicy.on': 'always power on',
  'restorePolicy.unknown': 'unknown',

  'powerEvent.acLost': 'input power lost',
  'powerEvent.overload': 'powered down by overload',
  'powerEvent.interlock': 'powered down by interlock',
  'powerEvent.fault': 'powered down by a power fault',
  'powerEvent.ipmiCommand': 'powered up by an IPMI command',
  'powerEvent.none': 'no data',

  'threshold.lowerNonCritical': 'below lower non-critical',
  'threshold.lowerCritical': 'below lower critical',
  'threshold.lowerNonRecoverable': 'below lower non-recoverable',
  'threshold.upperNonCritical': 'above upper non-critical',
  'threshold.upperCritical': 'above upper critical',
  'threshold.upperNonRecoverable': 'above upper non-recoverable',

  'dialog.chooseIso': 'Choose an ISO image',
  'dialog.diskImages': 'Disk images',

  'error.noConnection': 'No active connection to a BMC',
  'error.noKvmSession': 'The KVM session is not established',
  'error.cdServiceUnavailable':
    'The BMC reports the CD redirection service as unavailable: every slot is ' +
    'taken or the service is disabled. Fully power-cycling the server frees the slot.',
  'error.requestTimeout': 'The request to the BMC timed out',
  'error.badCredentials': 'The BMC rejected the login: wrong user name or password',
  'error.noSessionCookie': 'Could not obtain SESSION_COOKIE (HTTP {status})',
  'error.noKvmToken':
    'The JNLP contains no kvmtoken — the session has probably expired, or the user has no KVM rights',
  'error.shortChassisStatus': 'Short Get Chassis Status response',
  'error.shortDeviceId': 'Short Get Device ID response',
  'error.ipmiPasswordTooLong': 'An IPMI password cannot exceed 20 bytes',
  'error.ipmiBadPayloadLength': 'Invalid length of an encrypted IPMI payload',
  'error.ipmiBadPadding': 'Invalid padding in an IPMI payload',

  'kvm.disconnected': 'The connection to the BMC was lost',
  'kvm.sessionClosed': 'Session closed',
  'kvm.badPacketLength': 'Invalid packet length: {size}',
  'kvm.protocolError': 'Protocol error',
  'kvm.tokenRejected': 'The BMC rejected the kvmtoken: the session failed validation',
  'kvm.authFailed': 'Authentication error',
  'kvm.sessionLimit': 'The BMC refused: the limit of concurrent KVM sessions is reached',
  'kvm.closedByOther': 'The session was closed by another user',
  'kvm.closedByBmc': 'The BMC ended the session',
  'kvm.videoTokenRejected': 'The BMC rejected the video session token',
  'kvm.settingsChanged': 'Session closed: the BMC settings changed',
  'kvm.webLogout': 'Session closed: logged out of the web interface',
  'kvm.closedWithCode': 'Session closed by the BMC (code {status})',
  'kvm.disconnectedByUser': 'Disconnected by the user',

  'vm.disconnected': 'Virtual Media: the connection was lost',
  'vm.detached': 'Virtual Media detached',
  'vm.badIusbPacket': 'Virtual Media: malformed IUSB packet',
  'vm.protocolError': 'Virtual Media protocol error',
  'vm.busy': 'Virtual Media is already in use by client {ip}',
  'vm.refused': 'The BMC refused the Virtual Media connection',
  'vm.noAck': 'The BMC did not confirm the Virtual Media connection',
};

const RU: Record<string, string> = {
  'common.cancel': 'Отмена',
  'common.save': 'Сохранить',
  'common.retry': 'Повторить',
  'common.execute': 'Выполнить',
  'common.language': 'Язык',

  'servers.title': 'Серверы',
  'servers.add': 'Добавить сервер',
  'servers.empty': 'Пока ничего не добавлено. Нажмите «Добавить сервер», чтобы указать адрес BMC.',
  'servers.passwordSaved': 'пароль сохранён',
  'servers.connect': 'Подключиться',
  'servers.edit': 'Изменить',
  'servers.delete': 'Удалить',
  'servers.editTitle': 'Изменить сервер',
  'servers.newTitle': 'Новый сервер',
  'servers.name': 'Название',
  'servers.namePlaceholder': 'Например, node-01',
  'servers.host': 'Адрес BMC',
  'servers.port': 'Порт веб-интерфейса',
  'servers.user': 'Пользователь',
  'servers.password': 'Пароль',
  'servers.passwordStored': '(сохранится в хранилище ОС)',
  'servers.passwordKeep': 'оставьте пустым, чтобы не менять',
  'servers.noSecureStorage':
    'Система не предоставляет безопасное хранилище — пароль сохранён не будет.',
  'servers.passwordFor': 'Пароль для {name}',
  'servers.passwordForUser': 'Пароль пользователя {user}',

  'toolbar.disconnect': '← Отключиться',
  'toolbar.ctrlAltDel': 'Ctrl+Alt+Del',
  'toolbar.keyboard': '⌨ Клавиатура',
  'toolbar.keyboardTitle': 'Экранная клавиатура: нажатия мышью в обход клавиатуры хоста',
  'toolbar.refresh': 'Обновить экран',
  'toolbar.mountIso': 'Подключить ISO',
  'toolbar.unmountIso': '💿 Отключить образ',
  'toolbar.mountedTitle': 'Подключён образ: {path}',
  'toolbar.powerMenu': 'Питание ▾',
  'toolbar.sessions': 'сессий: {count}',
  'toolbar.mouseMode': 'Режим мыши',

  'tabs.console': 'Консоль',
  'tabs.sensors': 'Датчики',

  'badge.powerUnknown': 'питание: —',
  'badge.powerOn': 'питание: вкл',
  'badge.powerOff': 'питание: выкл',

  'mouse.absolute': 'Мышь: абсолютная',
  'mouse.relative': 'Мышь: относительная',
  'mouse.other': 'Мышь: прочий режим',

  'power.on': 'Включить',
  'power.orderly-shutdown': 'Штатное выключение (ACPI)',
  'power.hard-reset': 'Аппаратный сброс',
  'power.cycle': 'Перезапуск питания',
  'power.off-immediate': 'Обесточить немедленно',

  'confirm.title': 'Подтвердите действие',
  'confirm.body':
    '{action} — операция затронет работающую систему и может привести к потере данных.',

  'notice.powerOk': 'Команда питания выполнена',
  'notice.powerRejected': 'BMC отклонил команду питания (код {code})',
  'notice.noVideo': 'Сервер не выдаёт видеосигнал',
  'notice.mediaEjected': 'Сервер извлёк виртуальный диск',
  'notice.isoMounted': 'Образ подключён. Чтобы система его увидела, перезагрузите сервер.',
  'notice.isoMountFailed': 'Не удалось подключить образ: {error}',
  'notice.isoUnmounted': 'Образ отключён',

  'status.connecting': 'Подключение к BMC…',
  'status.authenticating': 'Авторизация KVM-сессии…',

  'console.waiting': 'Ожидание видеосигнала…',

  'vkbd.combos': 'Сочетания',
  'vkbd.releaseAll': 'Отпустить всё',
  'vkbd.releaseAllTitle': 'Отпустить все залипшие модификаторы',
  'vkbd.hint':
    'Клик по Ctrl, Shift, Alt или Win удерживает модификатор до следующей клавиши, ' +
    'повторный клик — до отмены. Физическая клавиатура работает параллельно.',
  'vkbd.win': 'Клавиша Windows / Command',
  'vkbd.menu': 'Контекстное меню',
  'vkbd.space': 'Пробел',
  'vkbd.backspace': 'Backspace',
  'vkbd.capsLock': 'Caps Lock',
  'combo.ctrlAltDel': 'Перезагрузка или экран безопасности в гостевой системе',
  'combo.altTab': 'Переключение окон в гостевой системе',
  'combo.altF4': 'Закрыть окно в гостевой системе',
  'combo.ctrlEsc': 'Открыть меню «Пуск»',
  'combo.winR': 'Диалог «Выполнить»',
  'combo.ctrlShiftEsc': 'Диспетчер задач',

  'sensors.group.temperature': 'Температура',
  'sensors.group.voltage': 'Напряжение',
  'sensors.group.fans': 'Вентиляторы',
  'sensors.group.power': 'Питание',
  'sensors.group.other': 'Прочее',
  'sensors.readFailed': 'Не удалось прочитать данные IPMI: {error}',
  'sensors.polling': 'Опрашиваю BMC по IPMI…',
  'sensors.firmware': 'Прошивка BMC {version}',
  'sensors.ipmi': 'IPMI {version}',
  'sensors.chassisOn': 'Шасси: питание включено',
  'sensors.chassisOff': 'Шасси: питание выключено',
  'sensors.lastEvent': 'Последнее событие: {event}',
  'sensors.restorePolicy': 'При восстановлении питания: {policy}',
  'sensors.refresh': 'Обновить',
  'sensors.refreshing': 'Обновляю…',
  'sensors.lastPollFailed': 'Последний опрос не удался: {error}',

  'fault.power': 'сбой питания',
  'fault.overload': 'перегрузка по питанию',
  'fault.cooling': 'сбой охлаждения',
  'fault.drive': 'сбой накопителя',
  'fault.intrusion': 'вскрытие корпуса',
  'fault.identify': 'индикация активна',

  'sel.title': 'Журнал событий ({count})',
  'sel.empty': 'Записей нет.',
  'sel.noTimestamp': 'без отметки времени',
  'sel.entry': 'датчик {number}, тип 0x{type}',
  'sel.assert': 'возникло',
  'sel.deassert': 'снято',

  'unit.C': '°C',
  'unit.F': '°F',
  'unit.K': 'K',
  'unit.V': 'В',
  'unit.A': 'А',
  'unit.W': 'Вт',
  'unit.J': 'Дж',
  'unit.RPM': 'об/мин',
  'unit.Hz': 'Гц',

  'restorePolicy.off': 'оставаться выключенным',
  'restorePolicy.previous': 'восстанавливать прежнее состояние',
  'restorePolicy.on': 'всегда включаться',
  'restorePolicy.unknown': 'неизвестно',

  'powerEvent.acLost': 'пропадание питания на входе',
  'powerEvent.overload': 'питание снято по перегрузке',
  'powerEvent.interlock': 'питание снято по блокировке',
  'powerEvent.fault': 'питание снято по сбою питания',
  'powerEvent.ipmiCommand': 'включение командой IPMI',
  'powerEvent.none': 'нет данных',

  'threshold.lowerNonCritical': 'ниже нижнего некритического',
  'threshold.lowerCritical': 'ниже нижнего критического',
  'threshold.lowerNonRecoverable': 'ниже нижнего аварийного',
  'threshold.upperNonCritical': 'выше верхнего некритического',
  'threshold.upperCritical': 'выше верхнего критического',
  'threshold.upperNonRecoverable': 'выше верхнего аварийного',

  'dialog.chooseIso': 'Выберите образ ISO',
  'dialog.diskImages': 'Образы дисков',

  'error.noConnection': 'Нет активного подключения к BMC',
  'error.noKvmSession': 'KVM-сессия не установлена',
  'error.cdServiceUnavailable':
    'BMC сообщает, что служба CD-редиректа недоступна: все слоты заняты ' +
    'или служба выключена. Освободить слот помогает полное обесточивание сервера.',
  'error.requestTimeout': 'Таймаут запроса к BMC',
  'error.badCredentials': 'BMC отклонил вход: неверный логин или пароль',
  'error.noSessionCookie': 'Не удалось получить SESSION_COOKIE (HTTP {status})',
  'error.noKvmToken':
    'В JNLP нет kvmtoken — вероятно, сессия истекла или у пользователя нет прав на KVM',
  'error.shortChassisStatus': 'Короткий ответ Get Chassis Status',
  'error.shortDeviceId': 'Короткий ответ Get Device ID',
  'error.ipmiPasswordTooLong': 'Пароль IPMI не может быть длиннее 20 байт',
  'error.ipmiBadPayloadLength': 'Некорректная длина зашифрованной нагрузки IPMI',
  'error.ipmiBadPadding': 'Некорректное дополнение в нагрузке IPMI',

  'kvm.disconnected': 'Соединение с BMC разорвано',
  'kvm.sessionClosed': 'Сессия закрыта',
  'kvm.badPacketLength': 'Некорректная длина пакета: {size}',
  'kvm.protocolError': 'Протокольная ошибка',
  'kvm.tokenRejected': 'BMC отклонил kvmtoken: сессия не прошла валидацию',
  'kvm.authFailed': 'Ошибка авторизации',
  'kvm.sessionLimit': 'BMC отказал: исчерпан лимит одновременных KVM-сессий',
  'kvm.closedByOther': 'Сессия закрыта другим пользователем',
  'kvm.closedByBmc': 'BMC завершил сессию',
  'kvm.videoTokenRejected': 'BMC отклонил токен видеосессии',
  'kvm.settingsChanged': 'Сессия закрыта: изменились настройки BMC',
  'kvm.webLogout': 'Сессия закрыта: выход из веб-интерфейса',
  'kvm.closedWithCode': 'Сессия закрыта BMC (код {status})',
  'kvm.disconnectedByUser': 'Отключено пользователем',

  'vm.disconnected': 'Virtual Media: соединение разорвано',
  'vm.detached': 'Virtual Media отключена',
  'vm.badIusbPacket': 'Virtual Media: некорректный пакет IUSB',
  'vm.protocolError': 'Протокольная ошибка Virtual Media',
  'vm.busy': 'Virtual Media уже используется клиентом {ip}',
  'vm.refused': 'BMC отклонил подключение Virtual Media',
  'vm.noAck': 'BMC не подтвердил подключение Virtual Media',
};

const DICTIONARIES: Record<Locale, Record<string, string>> = { en: EN, ru: RU };

/**
 * Looks a key up, falling back to English and then to the key itself — an
 * untranslated string is easier to diagnose on screen than an empty one.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = DICTIONARIES[locale][key] ?? EN[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export function formatMessage(locale: Locale, message: Message): string {
  return translate(locale, message.key, message.params);
}

/** Marks an encoded message inside an otherwise opaque error string. */
const ENCODED_PREFIX = 'i18n:';

/**
 * Errors crossing `ipcMain.handle` arrive in the renderer as plain text with
 * Electron's own wrapper around them, so the message travels encoded in the
 * error text and is picked back out by `decodeMessage`.
 */
export class AppError extends Error {
  constructor(
    readonly messageKey: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(ENCODED_PREFIX + JSON.stringify({ key: messageKey, params }));
    this.name = 'AppError';
  }
}

/**
 * Extracts a message encoded by `AppError` from arbitrary error text.
 * Returns null for anything else — a socket error keeps its own wording.
 */
export function decodeMessage(text: string): Message | null {
  const start = text.indexOf(ENCODED_PREFIX);
  if (start === -1) return null;

  const json = text.slice(start + ENCODED_PREFIX.length);
  // The encoded object ends at the last closing brace: Electron may append
  // its own text after it.
  const end = json.lastIndexOf('}');
  if (end === -1) return null;

  try {
    const parsed: unknown = JSON.parse(json.slice(0, end + 1));
    if (typeof parsed === 'object' && parsed !== null && 'key' in parsed) {
      return parsed as Message;
    }
  } catch {
    return null;
  }
  return null;
}

/** Renders an error for the user: a known message key, or the raw text. */
export function formatError(locale: Locale, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const decoded = decodeMessage(text);
  if (decoded) return formatMessage(locale, decoded);
  // Electron prefixes the original message with the failing channel name.
  return text.replace(/^Error: .*?Error: /, '');
}
