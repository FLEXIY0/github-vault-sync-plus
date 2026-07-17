import { Plugin, Notice, TFile, TAbstractFile } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile } from "./types";
import { MultiSyncSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";
import { t, setLang, detectLang } from "./i18n";

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

    // Keyboard command
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
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
        } catch {
          // Pull errors on open are non-fatal (e.g. offline) — just show error state
          this.setStatus("error", "Pull failed on open");
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

  /**
   * Called after the user connects their GitHub account.
   * Determines whether to clone (existing repo) or init+push (new repo).
   */
  async initializeRepo(token: string, username: string, customRepoName?: string): Promise<void> {
    this.setStatus("connecting");

    const vaultName = this.app.vault.getName();
    const repoName  = customRepoName || vaultNameToRepoName(vaultName);
    this.settings.repoName = repoName;

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
      // clone() returns false when the remote is empty (a previous initAndPush
      // created the repo but never pushed any commits). In that case fall back
      // to initAndPush so we establish the local branch and push.
      const cloneHadCommits = await sync.clone();
      if (!cloneHadCommits) {
        await sync.initAndPush(allFiles());
        new Notice(`${t("initialisedRepo")}: ${username}/${repoName}`);
      } else {
        new Notice(`${t("clonedRepo")}: ${username}/${repoName}`);
      }
    } else {
      // Already initialised locally — update remote URL if changed, then reconnect.
      const switched = await sync.updateRemote();
      if (switched) {
        new Notice(`${t("reconnected")}: ${username}/${repoName}`);
      } else {
        new Notice(`${t("reconnected")}: ${username}/${repoName}`);
      }
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName } = this.settings;
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

    this.syncQueue = new SyncQueue(this.gitSync, (status, detail) => {
      this.setStatus(status, detail);
      if (status === "idle") {
        this.settings.lastSyncTime = Date.now();
        this.saveSettings();
      }
    });
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
      }
      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict");
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice(t("syncedOk"));
      } else {
        this.setStatus("error", result.error);
        new Notice(`${t("syncError")}: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`${t("syncFailed")}: ${msg}`);
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
    return this.settings.excludePatterns.some((pattern) => {
      // Convert simple glob pattern (supports *) to regex
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regexStr = escaped.replace(/\*/g, ".*");
      return new RegExp(`^${regexStr}$`).test(filepath);
    });
  }
}
