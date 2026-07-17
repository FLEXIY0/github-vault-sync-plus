export type Lang = "en" | "ru";

const en = {
  settingsTitle: "Git Sync+ Settings",
  ghAccount: "GitHub Account",
  connectedAccount: "Connected account",
  signedInAs: "Signed in as",
  disconnect: "Disconnect",
  disconnectedNotice: "Disconnected from GitHub.",
  vaultRepo: "Vault repo",
  connectName: "Connect GitHub account",
  connectDesc: "Authorise Git Sync+ to access your repos. Opens a browser window.",
  connectBtn: "Connect GitHub",
  cancel: "Cancel",
  syncOptions: "Sync Options",
  autoSync: "Auto-sync",
  autoSyncDesc: "Automatically sync when files are modified.",
  debounce: "Sync debounce (ms)",
  debounceDesc: "Wait this many milliseconds after the last edit before syncing.",
  excluded: "Excluded patterns",
  excludedDesc: "One pattern per line. These files will never be synced.",
  manualSync: "Manual Sync",
  syncNow: "Sync now",
  syncNowDesc: "Immediately push all local changes and pull remote changes.",
  syncNowBtn: "Sync Now",
  lastSynced: "Last synced",
  advanced: "Advanced: use your own access",
  clientId: "Custom OAuth Client ID",
  clientIdDesc:
    "Use your own GitHub OAuth app for the Connect button instead of the built-in one. " +
    "Create it at github.com/settings/developers and tick \"Enable Device Flow\". Leave empty for the default.",
  pat: "Personal Access Token",
  patDesc:
    "Connect with a token instead of OAuth — no third-party app, access can be limited to a single repo. " +
    "Fine-grained token with Contents read/write on your vault repo, or a classic token with the \"repo\" scope.",
  connect: "Connect",
  connectingBtn: "Connecting…",
  pasteToken: "Paste a token first.",
  tokenConnected: "Connected via token as",
  tokenFailed: "Token connection failed",
  openUrl: "Open this URL in your browser and enter the code below:",
  waiting: "Waiting for you to approve in the browser…",
  copyCode: "Copy code",
  clickToCopy: "Click to copy",
  codeCopied: "Code copied to clipboard.",
  copyFailed: "Could not copy — select the code manually.",
  connectionFailed: "Connection failed",
  connectedAs: "Connected as",
  syncStarted: "Vault syncing started!",
  history: "Sync History",
  historyEmpty: "No sync history yet.",
  syncsWord: "syncs",
  pickDay: "Click a day on the map to see its commits.",
  noCommitsThisDay: "No commits on this day.",
  restore: "Restore",
  restoreConfirm: "Restore the vault to this commit? The current state stays in history and can be restored back.",
  restoring: "Restoring…",
  restored: "Vault restored to selected commit.",
  restoreFailed: "Restore failed",
  terminal: "Git Console",
  termPlaceholder: "command… (help)",
  termUnknown: "Unknown command. Type: help",
  termHelp:
    "help              this help\n" +
    "status            changed files\n" +
    "log [n]           last n commits (default 10)\n" +
    "graph [n]         commit tree with branch labels\n" +
    "branch            list branches\n" +
    "checkout <ref>    switch to branch/commit\n" +
    "restore <sha>     restore vault to commit\n" +
    "sync | pull | push\n" +
    "force-delete      sync including mass deletions\n" +
    "remote            show remote URL\n" +
    "clear             clear output",
  branches: "Branches",
  graphChip: "Tree",
  filesWord: "files",
  loadingDiff: "Loading changes…",
  noChanges: "No changes.",
  tooLarge: "File is too large to diff.",
  clean: "Working tree clean.",
  notConnected: "Git Sync+: not connected. Please connect your GitHub account in settings.",
  syncedOk: "Vault synced successfully.",
  syncError: "Sync error",
  syncFailed: "Sync failed",
  createdRepo: "Created private repo",
  clonedRepo: "Cloned repo",
  initialisedRepo: "Initialised repo",
  reconnected: "Reconnected to",
  changeRepoConfirm: "Are you sure you want to change the repository to {{repo}}? This will switch the remote sync target. Files are merged; local versions always win — nothing is deleted.",
  changeRepoConfirmTitle: "Confirm Repository Change",
  confirm: "Confirm",
  repoChangedNotice: "Repository changed to {{repo}}.",
  languageOptionName: "Language",
  languageOptionDesc: "Select the interface language.",
  newRepoName: "New repository",
  newRepoDesc: "Create (or switch to) a repo by name. \"obsidian\" is required in the name and added automatically if missing.",
  switchBtn: "Switch",
  switchedTo: "Switched to",
  switchFailed: "Switch failed",
  deletionGuardNotice: "Mass-deletion guard: file deletions were NOT synced. If intentional, run force-delete in the Git Console.",
  logTitle: "Sync Log",
  clearLog: "Clear",
  logEmpty: "No sync events yet.",
  logAuto: "Auto-sync",
  logManual: "Manual sync",
  logPull: "Pull on open",
  logGuard: "Deletions skipped by guard",
  logRestore: "Restored to commit",
  logSwitch: "Switched repo",
  // status bar
  stSyncing: "Syncing",
  stConflict: "Conflict",
  stError: "Sync Error",
  stConnecting: "Connecting",
  stSynced: "Synced",
  stNow: "now",
  sufMin: "m",
  sufHour: "h",
  sufDay: "d",
};

const ru: typeof en = {
  settingsTitle: "Настройки Git Sync+",
  ghAccount: "Аккаунт GitHub",
  connectedAccount: "Подключённый аккаунт",
  signedInAs: "Вы вошли как",
  disconnect: "Отключить",
  disconnectedNotice: "Отключено от GitHub.",
  vaultRepo: "Репозиторий хранилища",
  connectName: "Подключить аккаунт GitHub",
  connectDesc: "Разрешите Git Sync+ доступ к репозиториям. Откроется окно браузера.",
  connectBtn: "Подключить GitHub",
  cancel: "Отмена",
  syncOptions: "Параметры синхронизации",
  autoSync: "Автосинхронизация",
  autoSyncDesc: "Синхронизировать автоматически при изменении файлов.",
  debounce: "Задержка синка (мс)",
  debounceDesc: "Подождать столько миллисекунд после последней правки перед синком.",
  excluded: "Исключённые шаблоны",
  excludedDesc: "По одному шаблону на строку. Эти файлы не синхронизируются.",
  manualSync: "Ручная синхронизация",
  syncNow: "Синхронизировать",
  syncNowDesc: "Сразу отправить локальные изменения и получить удалённые.",
  syncNowBtn: "Синк",
  lastSynced: "Последний синк",
  advanced: "Дополнительно: свой доступ",
  clientId: "Свой OAuth Client ID",
  clientIdDesc:
    "Использовать своё OAuth-приложение GitHub для кнопки подключения. " +
    "Создайте его на github.com/settings/developers и включите «Enable Device Flow». Пусто — приложение по умолчанию.",
  pat: "Personal Access Token",
  patDesc:
    "Подключение по токену вместо OAuth — без сторонних приложений, доступ можно ограничить одним репозиторием. " +
    "Fine-grained токен с правами Contents read/write на репозиторий хранилища, либо классический со scope «repo».",
  connect: "Подключить",
  connectingBtn: "Подключение…",
  pasteToken: "Сначала вставьте токен.",
  tokenConnected: "Подключено по токену как",
  tokenFailed: "Не удалось подключиться по токену",
  openUrl: "Откройте этот адрес в браузере и введите код ниже:",
  waiting: "Ожидание подтверждения в браузере…",
  copyCode: "Скопировать код",
  clickToCopy: "Нажмите, чтобы скопировать",
  codeCopied: "Код скопирован в буфер обмена.",
  copyFailed: "Не удалось скопировать — выделите код вручную.",
  connectionFailed: "Не удалось подключиться",
  connectedAs: "Подключено как",
  syncStarted: "Синхронизация хранилища запущена!",
  history: "История синхронизаций",
  historyEmpty: "Истории синхронизаций пока нет.",
  syncsWord: "синков",
  pickDay: "Нажмите на день на карте, чтобы увидеть коммиты.",
  noCommitsThisDay: "В этот день коммитов не было.",
  restore: "Восстановить",
  restoreConfirm: "Восстановить хранилище к этому коммиту? Текущее состояние останется в истории, к нему можно вернуться.",
  restoring: "Восстановление…",
  restored: "Хранилище восстановлено к выбранному коммиту.",
  restoreFailed: "Не удалось восстановить",
  terminal: "Git-консоль",
  termPlaceholder: "команда… (help)",
  termUnknown: "Неизвестная команда. Введите: help",
  termHelp:
    "help              эта справка\n" +
    "status            изменённые файлы\n" +
    "log [n]           последние n коммитов (по умолч. 10)\n" +
    "graph [n]         дерево коммитов с метками веток\n" +
    "branch            список веток\n" +
    "checkout <ref>    переключиться на ветку/коммит\n" +
    "restore <sha>     восстановить хранилище к коммиту\n" +
    "sync | pull | push\n" +
    "force-delete      синк вместе с массовыми удалениями\n" +
    "remote            показать адрес репозитория\n" +
    "clear             очистить вывод",
  branches: "Ветки",
  graphChip: "Дерево",
  filesWord: "файлов",
  loadingDiff: "Загрузка изменений…",
  noChanges: "Изменений нет.",
  tooLarge: "Файл слишком большой для сравнения.",
  clean: "Изменений нет.",
  notConnected: "Git Sync+: не подключено. Подключите аккаунт GitHub в настройках.",
  syncedOk: "Хранилище синхронизировано.",
  syncError: "Ошибка синка",
  syncFailed: "Синк не удался",
  createdRepo: "Создан приватный репозиторий",
  clonedRepo: "Клонирован репозиторий",
  initialisedRepo: "Инициализирован репозиторий",
  reconnected: "Переподключено к",
  changeRepoConfirm: "Переключить репозиторий на {{repo}}? Цель синхронизации изменится. Файлы объединяются, локальные версии в приоритете — ничего не удаляется.",
  changeRepoConfirmTitle: "Подтверждение смены репозитория",
  confirm: "Подтвердить",
  repoChangedNotice: "Репозиторий изменён на {{repo}}.",
  languageOptionName: "Язык",
  languageOptionDesc: "Выбор языка интерфейса.",
  newRepoName: "Новый репозиторий",
  newRepoDesc: "Создать репозиторий (или переключиться) по имени. В названии обязательно «obsidian» — если нет, добавится автоматически.",
  switchBtn: "Переключить",
  switchedTo: "Переключено на",
  switchFailed: "Не удалось переключить",
  deletionGuardNotice: "Защита от массового удаления: удаления файлов НЕ синхронизированы. Если это намеренно — выполните force-delete в Git-консоли.",
  logTitle: "Логи синхронизации",
  clearLog: "Очистить",
  logEmpty: "Событий синхронизации пока нет.",
  logAuto: "Автосинк",
  logManual: "Ручной синк",
  logPull: "Pull при открытии",
  logGuard: "Удаления пропущены защитой",
  logRestore: "Восстановлено к коммиту",
  logSwitch: "Смена репозитория",
  stSyncing: "Синк",
  stConflict: "Конфликт",
  stError: "Ошибка синка",
  stConnecting: "Подключение",
  stSynced: "Синхронизировано",
  stNow: "сейчас",
  sufMin: "м",
  sufHour: "ч",
  sufDay: "д",
};

const LANGS: Record<Lang, typeof en> = { en, ru };

let current: Lang = "en";

/** Detect Obsidian's UI language (stored in localStorage by the app) */
export function detectLang(): Lang {
  try {
    const appLang = window.localStorage.getItem("language") ?? "en";
    return appLang.startsWith("ru") ? "ru" : "en";
  } catch {
    return "en";
  }
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(key: keyof typeof en): string {
  return LANGS[current][key] ?? en[key];
}
