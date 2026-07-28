import { Plugin, Notice, TFile, TAbstractFile } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile, SyncLogEntry } from "./types";
import { SyncLogView, LOG_VIEW_TYPE } from "./ui/log-view";
import { MultiSyncSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";
import { t, setLang, detectLang } from "./i18n";

/** Attachment types a phone must never push into the lightweight mirror */
const ATTACHMENT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|flac|zip|7z|rar)$/i;

export default class MultiSyncPlugin extends Plugin {
  settings!: PluginSettings;
  private statusBar!: StatusBarItem;
  gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    setLang(this.settings.language || detectLang());

    this.statusBar = new StatusBarItem(this, () => this.settings.lastSyncTime);
    this.statusBar.onClick(() => this.triggerManualSync());
    // Keep the "time since last sync" label fresh while idle
    this.registerInterval(window.setInterval(() => this.statusBar.refresh(), 30_000));

    this.addSettingTab(new MultiSyncSettingsTab(this.app, this));

    // Sidebar sync log
    this.registerView(LOG_VIEW_TYPE, (leaf) => new SyncLogView(leaf, this));
    this.addRibbonIcon("history", t("logTitle"), () => void this.activateLogView());

    // Keyboard commands
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
    });
    this.addCommand({
      id: "open-sync-log",
      name: "Open sync log",
      callback: () => void this.activateLogView(),
    });

    // Boot sync engine if already connected
    if (
      this.settings.githubToken &&
      this.settings.githubUsername &&
      this.settings.repoName
    ) {
      await this.bootSyncEngine();
    }

    // Pull on open — wait for workspace to be ready
    this.app.workspace.onLayoutReady(async () => {
      if (this.gitSync) {
        this.setStatus("pulling");
        try {
          await this.gitSync.pull();
          this.setStatus("idle");
          this.log("ok", t("logPull"));
        } catch (err) {
          // Pull errors on open are non-fatal (e.g. offline) — just show error state
          this.setStatus("error", "Pull failed on open");
          this.log("error", `${t("logPull")}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // Watch file changes for auto-sync
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (_file: TAbstractFile, oldPath: string) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        this.syncQueue.enqueue(oldPath);
      })
    );
  }

  async onunload(): Promise<void> {
    // Flush pending changes on close
    if (this.syncQueue) {
      await this.syncQueue.flushNow();
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  setStatus(status: SyncStatus, detail?: string): void {
    this.statusBar.set(status, detail);
  }

  /** Append an entry to the persistent sync log and refresh open log views */
  log(status: SyncLogEntry["status"], message: string): void {
    this.settings.syncLog.push({ time: Date.now(), status, message });
    if (this.settings.syncLog.length > 200) {
      this.settings.syncLog.splice(0, this.settings.syncLog.length - 200);
    }
    void this.saveSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE)) {
      if (leaf.view instanceof SyncLogView) leaf.view.refresh();
    }
  }

  async activateLogView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: LOG_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /**
   * Called after the user connects their GitHub account.
   * Determines whether to clone (existing repo) or init+push (new repo).
   */
  async initializeRepo(token: string, username: string, customRepoName?: string): Promise<void> {
    this.setStatus("connecting");

    const vaultName = this.app.vault.getName();
    // The repo this vault is already bound to always wins. Re-deriving the name
    // from the vault title on every connect is what made reconnecting create a
    // brand-new empty repo — a vault called "Obsidian Vault" resolves to
    // "obsidian-obsidian-vault", which never matches the real repo, so the
    // "repo does not exist" branch fired and created one.
    const baseRepo =
      customRepoName || this.settings.repoName || vaultNameToRepoName(vaultName);
    this.settings.repoName = baseRepo;
    // On a phone every operation below targets the mirror, not the full vault.
    const repoName = this.activeRepoName();

    const adapter = this.app.vault.adapter;
    // Obsidian exposes basePath on FileSystemAdapter (desktop). On mobile the vault
    // root is the adapter itself, so we fall back to an empty string which causes
    // isomorphic-git to use relative paths from the adapter root.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    const sync = new GitSync(adapter, vaultPath, token, username, repoName);
    sync.onProgress = (pct, phase) => this.statusBar.progress(pct, phase);

    const exists      = await repoExists(token, username, repoName);
    const alreadyInit = await sync.isInitialized();

    const allFiles = () => [...this.syncableFiles(), ...this.selfSyncFiles()];

    if (!exists) {
      // Brand-new vault — create repo and push everything
      await createRepo(token, repoName, `Obsidian vault: ${vaultName}`);
      if (alreadyInit) {
        // Local git exists (switching from another repo) — update remote and force-push
        await sync.updateRemote();
        new Notice(`${t("createdRepo")}: ${username}/${repoName}`);
      } else {
        await sync.initAndPush(allFiles());
        new Notice(`${t("createdRepo")}: ${username}/${repoName}`);
      }
    } else if (!alreadyInit) {
      // Repo exists remotely, this is a new device — clone it.
      const cloneHadCommits = await sync.clone();
      if (cloneHadCommits) {
        new Notice(`${t("clonedRepo")}: ${username}/${repoName}`);
      } else if (await sync.remoteHasCommits()) {
        // The clone produced no local branch even though the repo HAS history.
        // Falling back to initAndPush here (the old behaviour) started a fresh
        // orphan history containing only this device's files, which can never
        // fast-forward onto the real one — every later push was rejected, and
        // a force-push would have wiped the repo. Stop instead: the vault and
        // the repo are both intact, and a retry can still succeed.
        throw new Error(
          `Could not download ${username}/${repoName}, which already has history. ` +
          `Nothing was changed — check your connection and try connecting again.`
        );
      } else {
        // Remote is genuinely empty (repo created earlier but never pushed to)
        // — establishing the first history here is correct.
        await sync.initAndPush(allFiles());
        new Notice(`${t("initialisedRepo")}: ${username}/${repoName}`);
      }
    } else {
      // Already initialised locally — point at the repo and reconcile with it.
      // adoptRemote unions both sides (local versions win, nothing is deleted),
      // so a device whose local history diverged still recovers instead of
      // being stuck on rejected pushes.
      await sync.setOrigin();
      await sync.adoptRemote();
      new Notice(`${t("reconnected")}: ${username}/${repoName}`);
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername } = this.settings;
    const repoName = this.activeRepoName();
    if (!githubToken || !githubUsername || !repoName) return;

    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    this.gitSync = new GitSync(
      adapter,
      vaultPath,
      githubToken,
      githubUsername,
      repoName
    );
    this.gitSync.onProgress = (pct, phase) => this.statusBar.progress(pct, phase);

    this.syncQueue = new SyncQueue(
      this.gitSync,
      (status, detail) => {
        this.setStatus(status, detail);
        if (status === "idle") {
          this.settings.lastSyncTime = Date.now();
          this.saveSettings();
        }
      },
      () => this.settings.syncIntervalMs,
      (result, fileCount) => {
        if (result.skippedDeletions) {
          this.log("guard", `${t("logGuard")} (${result.skippedDeletions})`);
        }
        if (result.conflictFiles.length > 0) {
          this.log("conflict", `${t("stConflict")}: ${result.conflictFiles.map((f) => f.path).join(", ")}`);
        } else if (result.success) {
          this.log("ok", `${t("logAuto")} (${fileCount})`);
        } else {
          this.log("error", `${t("logAuto")}: ${result.error ?? "?"}`);
        }
      }
    );
  }

  /**
   * The repo this device actually syncs with.
   *
   * A phone syncs "<vault-repo>-mobile": the notes without attachments. The
   * full vault can be tens of megabytes, and Obsidian mobile buffers an entire
   * pack in memory while cloning, which crashes it outright. `repoName` still
   * identifies the vault on every device; only the traffic is redirected.
   */
  activeRepoName(): string {
    const base = this.settings.repoName;
    if (!base) return "";
    return this.settings.mobileMode ? `${base}-mobile` : base;
  }

  /** Vault files eligible for sync */
  private syncableFiles(): string[] {
    return this.app.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => !this.isExcluded(p));
  }

  /**
   * The plugin's own files, synced through the vault repo so other devices
   * (including mobile) receive plugin updates automatically with the notes.
   */
  private selfSyncFiles(): string[] {
    const dir = this.manifest.dir;
    if (!dir) return [];
    return [`${dir}/main.js`, `${dir}/manifest.json`, `${dir}/styles.css`];
  }

  async triggerManualSync(): Promise<void> {
    if (!this.gitSync) {
      new Notice(t("notConnected"));
      return;
    }

    this.setStatus("pulling");
    try {
      const result = await this.gitSync.sync([
        ...this.syncableFiles(),
        ...this.selfSyncFiles(),
      ]);

      if (result.skippedDeletions) {
        new Notice(`${t("deletionGuardNotice")} (${result.skippedDeletions})`, 10000);
        this.log("guard", `${t("logGuard")} (${result.skippedDeletions})`);
      }
      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict");
        this.log("conflict", `${t("stConflict")}: ${result.conflictFiles.map((f) => f.path).join(", ")}`);
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice(t("syncedOk"));
        this.log("ok", t("logManual"));
      } else {
        this.setStatus("error", result.error);
        new Notice(`${t("syncError")}: ${result.error}`);
        this.log("error", `${t("logManual")}: ${result.error ?? "?"}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`${t("syncFailed")}: ${msg}`);
      this.log("error", `${t("logManual")}: ${msg}`);
    }
  }

  /**
   * Switch the vault to a different GitHub repo. Repo names must contain
   * "obsidian" (prefixed automatically otherwise); a missing repo is created.
   * Local files always survive: histories merge, or the remote is adopted
   * with a union of files where local versions win.
   */
  async switchRepo(rawName: string): Promise<void> {
    const { githubToken: token, githubUsername: username } = this.settings;
    if (!token || !username) {
      new Notice(t("notConnected"));
      return;
    }
    let repoName = rawName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!repoName) return;
    if (!repoName.includes("obsidian")) repoName = `obsidian-${repoName}`;
    if (repoName === this.settings.repoName) return;

    this.setStatus("connecting");
    try {
      if (!(await repoExists(token, username, repoName))) {
        await createRepo(token, repoName, `Obsidian vault: ${this.app.vault.getName()}`);
      }
      this.settings.repoName = repoName;
      await this.saveSettings();
      await this.bootSyncEngine();
      await this.gitSync!.setOrigin();
      await this.gitSync!.adoptRemote();
      await this.triggerManualSync();
      new Notice(`${t("switchedTo")}: ${username}/${repoName}`);
      this.log("info", `${t("logSwitch")}: ${username}/${repoName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`${t("switchFailed")}: ${msg}`);
    }
  }

  private showConflictModal(conflicts: ConflictFile[]): void {
    new ConflictModal(
      this.app,
      conflicts,
      async (filepath, resolved) => {
        await this.gitSync!.resolveConflict(filepath, resolved);
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
      }
    ).open();
  }

  private isExcluded(filepath: string): boolean {
    // Keeping the mirror small is the whole reason it exists — a phone never
    // pushes attachments into it, whatever the user's patterns say.
    if (this.settings.mobileMode && ATTACHMENT_RE.test(filepath)) return true;
    return this.settings.excludePatterns.some((pattern) => {
      // Convert simple glob pattern (supports *) to regex
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regexStr = escaped.replace(/\*/g, ".*");
      return new RegExp(`^${regexStr}$`).test(filepath);
    });
  }
}
