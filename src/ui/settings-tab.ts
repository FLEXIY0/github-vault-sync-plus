import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type MultiSyncPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { getAuthenticatedUser, getUserRepos } from "../github/api";
import { CLIENT_ID } from "../constants";
import { t, getLang, setLang, Lang } from "../i18n";
import { CommitInfo, FileChange } from "../sync/git-sync";
import { CommitDetailModal } from "./commit-modal";
import { ConfirmModal } from "./confirm-modal";

export class MultiSyncSettingsTab extends PluginSettingTab {
  plugin: MultiSyncPlugin;
  private termHistory: string[] = [];
  private termHistoryIdx = -1;
  private changesCache = new Map<string, FileChange[]>();
  private commitsCache: { at: number; commits: CommitInfo[] } | null = null;

  private async getChanges(oid: string): Promise<FileChange[]> {
    const cached = this.changesCache.get(oid);
    if (cached) return cached;
    const changes = await this.plugin.gitSync!.commitChanges(oid);
    this.changesCache.set(oid, changes);
    return changes;
  }

  constructor(app: App, plugin: MultiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    const header = containerEl.createDiv({ cls: "multisync-header" });
    header.createEl("h2", { text: t("settingsTitle") });

    const settings = this.plugin.settings;

    // ── Account section ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: t("ghAccount") });

    if (settings.githubToken && settings.githubUsername) {
      new Setting(containerEl)
        .setName(t("connectedAccount"))
        .setDesc(`${t("signedInAs")} @${settings.githubUsername}`)
        .addButton((btn) =>
          btn
            .setButtonText(t("disconnect"))
            .setWarning()
            .onClick(async () => {
              settings.githubToken = "";
              settings.githubUsername = "";
              settings.repoName = "";
              await this.plugin.saveSettings();
              this.display();
              new Notice(t("disconnectedNotice"));
            })
        );

      new Setting(containerEl)
        .setName(t("vaultRepo"))
        .setDesc(`github.com/${settings.githubUsername}/${settings.repoName}`)
        .addDropdown(async (dropdown) => {
          if (settings.repoName) {
            dropdown.addOption(settings.repoName, settings.repoName);
            dropdown.setValue(settings.repoName);
          }

          try {
            // Only repos with "obsidian" in the name are valid sync targets
            const repos = (await getUserRepos(settings.githubToken)).filter((r) =>
              r.name.toLowerCase().includes("obsidian")
            );
            dropdown.selectEl.innerHTML = "";
            let currentExists = false;
            for (const r of repos) {
              dropdown.addOption(r.name, r.name);
              if (r.name === settings.repoName) {
                currentExists = true;
              }
            }
            if (settings.repoName && !currentExists) {
              dropdown.addOption(settings.repoName, settings.repoName);
            }
            dropdown.setValue(settings.repoName);
          } catch (err) {
            console.error("Failed to fetch GitHub repositories:", err);
          }

          dropdown.onChange((val) => {
            if (val === settings.repoName) return;

            const confirmMsg = t("changeRepoConfirm").replace("{{repo}}", val);
            new ConfirmModal(
              this.app,
              confirmMsg,
              async () => {
                // switchRepo merges histories safely — local files always win
                await this.plugin.switchRepo(val);
                this.display();
              },
              () => {
                dropdown.setValue(settings.repoName);
              }
            ).open();
          });
        });

      // Create/switch to a brand-new repo by name ("obsidian" enforced)
      let newRepoName = "";
      new Setting(containerEl)
        .setName(t("newRepoName"))
        .setDesc(t("newRepoDesc"))
        .addText((el) =>
          el.setPlaceholder("obsidian-…").onChange((v) => (newRepoName = v.trim()))
        )
        .addButton((btn) =>
          btn.setButtonText(t("switchBtn")).onClick(async () => {
            if (!newRepoName) return;
            btn.setDisabled(true).setButtonText(t("connectingBtn"));
            await this.plugin.switchRepo(newRepoName);
            this.display();
          })
        );
    } else {
      new Setting(containerEl)
        .setName(t("connectName"))
        .setDesc(t("connectDesc"))
        .addButton((btn) => {
          btn
            .setButtonText(t("connectBtn"))
            .setCta()
            .onClick(async () => {
              await this.startDeviceFlow(btn);
            });
        });
    }

    // ── Sync options ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: t("syncOptions") });

    new Setting(containerEl)
      .setName(t("autoSync"))
      .setDesc(t("autoSyncDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("debounce"))
      .setDesc(t("debounceDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(1000, 10000, 500)
          .setValue(settings.syncIntervalMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            settings.syncIntervalMs = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("excluded"))
      .setDesc(t("excludedDesc"))
      .addTextArea((ta) =>
        ta
          .setValue(settings.excludePatterns.join("\n"))
          .onChange(async (val) => {
            settings.excludePatterns = val
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Manual sync ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: t("manualSync") });

    new Setting(containerEl)
      .setName(t("syncNow"))
      .setDesc(t("syncNowDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("syncNowBtn")).onClick(async () => {
          await this.plugin.triggerManualSync();
        })
      );

    if (settings.lastSyncTime > 0) {
      const lastSync = new Date(settings.lastSyncTime).toLocaleString();
      containerEl.createEl("p", {
        text: `${t("lastSynced")}: ${lastSync}`,
        cls: "setting-item-description",
      });
    }

    this.displayAdvancedSection(containerEl);

    if (this.plugin.gitSync) {
      // Fire and forget — history loads async below the fold
      void this.displayHistory(containerEl);
      this.displayTerminal(containerEl);
    }
  }

  // ══ Sync history heatmap ═══════════════════════════════════════════════════

  private async displayHistory(containerEl: HTMLElement): Promise<void> {
    const section = containerEl.createDiv({ cls: "multisync-history" });
    section.createEl("h3", { text: t("history") });

    // Reuse commits loaded within the last 30s — display() re-renders often
    let commits: CommitInfo[];
    if (this.commitsCache && Date.now() - this.commitsCache.at < 30_000) {
      commits = this.commitsCache.commits;
    } else {
      commits = await this.plugin.gitSync!.recentCommits(300);
      this.commitsCache = { at: Date.now(), commits };
    }
    if (commits.length === 0) {
      section.createEl("p", { text: t("historyEmpty"), cls: "setting-item-description" });
      return;
    }

    // Group commits by local date
    const dayKey = (ts: number) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const byDay = new Map<string, CommitInfo[]>();
    for (const c of commits) {
      const key = dayKey(c.timestamp);
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(c);
    }

    // Build a 26-week grid ending today, columns = weeks, rows = Mon..Sun
    const grid = section.createDiv({ cls: "multisync-heatmap" });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    const start = new Date(today);
    start.setDate(start.getDate() - 26 * 7 + 1);
    // Align start to Monday
    while (start.getDay() !== 1) start.setDate(start.getDate() - 1);

    const detail = section.createDiv({ cls: "multisync-day-detail" });
    detail.createEl("p", { text: t("pickDay"), cls: "setting-item-description" });

    let selected: HTMLElement | null = null;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d.getTime());
      const dayCommits = byDay.get(key) ?? [];
      const n = dayCommits.length;
      const level = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 7 ? 3 : 4;
      const cell = grid.createDiv({ cls: "multisync-cell" });
      cell.setAttribute("data-level", String(level));
      cell.setAttribute("title", `${key} · ${n} ${t("syncsWord")}`);
      cell.addEventListener("click", () => {
        selected?.removeClass("is-selected");
        selected = cell;
        cell.addClass("is-selected");
        this.renderDayCommits(detail, key, dayCommits);
      });
    }
  }

  private renderDayCommits(detail: HTMLElement, day: string, commits: CommitInfo[]): void {
    detail.empty();
    detail.createEl("h4", { text: day });
    if (commits.length === 0) {
      detail.createEl("p", { text: t("noCommitsThisDay"), cls: "setting-item-description" });
      return;
    }
    for (const c of commits) {
      const row = detail.createDiv({ cls: "multisync-commit-row" });
      const time = new Date(c.timestamp).toLocaleTimeString().slice(0, 5);
      row.createSpan({ cls: "multisync-commit-time", text: time });
      row.createSpan({ cls: "multisync-commit-msg", text: c.message });
      row.createSpan({ cls: "multisync-commit-sha", text: c.oid.slice(0, 7) });

      // Hover: floating mini-preview of the changed files
      let tip: HTMLElement | null = null;
      let tipTimer = 0;
      const hideTip = () => {
        window.clearTimeout(tipTimer);
        tip?.remove();
        tip = null;
      };
      row.addEventListener("mouseenter", () => {
        tipTimer = window.setTimeout(async () => {
          const changes = await this.getChanges(c.oid).catch(() => [] as FileChange[]);
          if (!row.isConnected) return;
          hideTip();
          tip = document.body.createDiv({ cls: "multisync-tip" });
          const rect = row.getBoundingClientRect();
          tip.style.left = `${rect.left + 24}px`;
          tip.style.top = `${rect.bottom + 4}px`;
          tip.createDiv({
            cls: "multisync-tip-head",
            text: `${changes.length} ${t("filesWord")}`,
          });
          for (const change of changes.slice(0, 10)) {
            const line = tip.createDiv({ cls: "multisync-tip-line" });
            line.createSpan({
              cls: `multisync-tip-badge is-${change.type}`,
              text: change.type === "add" ? "+" : change.type === "del" ? "−" : "±",
            });
            line.createSpan({ text: change.path });
          }
          if (changes.length > 10) {
            tip.createDiv({ cls: "multisync-tip-line", text: `… +${changes.length - 10}` });
          }
        }, 250);
      });
      row.addEventListener("mouseleave", hideTip);

      // Click: side panel with the file list and per-file diff
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).tagName === "BUTTON") return;
        hideTip();
        new CommitDetailModal(this.app, this.plugin, c).open();
      });

      const btn = row.createEl("button", { text: t("restore"), cls: "multisync-restore" });
      btn.addEventListener("click", async () => {
        if (!window.confirm(t("restoreConfirm"))) return;
        btn.setText(t("restoring"));
        btn.disabled = true;
        try {
          await this.plugin.gitSync!.restoreCommit(c.oid);
          this.commitsCache = null;
          this.plugin.settings.lastSyncTime = Date.now();
          await this.plugin.saveSettings();
          this.plugin.setStatus("idle");
          new Notice(t("restored"));
          this.plugin.log("info", `${t("logRestore")}: ${c.oid.slice(0, 7)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`${t("restoreFailed")}: ${msg}`);
        }
        btn.setText(t("restore"));
        btn.disabled = false;
      });
    }
  }

  // ══ Git console ════════════════════════════════════════════════════════════

  private displayTerminal(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "multisync-term-section" });
    section.createEl("h3", { text: t("terminal") });

    const term = section.createDiv({ cls: "multisync-term" });

    // Quick actions row
    const actions = term.createDiv({ cls: "multisync-term-actions" });
    const out = term.createDiv({ cls: "multisync-term-out" });

    const print = (text: string, cls?: string) => {
      for (const line of text.split("\n")) {
        out.createDiv({ cls: `multisync-term-line ${cls ?? ""}`, text: line });
      }
      out.scrollTop = out.scrollHeight;
    };

    const run = async (raw: string) => {
      const cmd = raw.trim().replace(/^git\s+/, "");
      if (!cmd) return;
      print(`❯ ${cmd}`, "is-cmd");
      const g = this.plugin.gitSync!;
      const [name, ...args] = cmd.split(/\s+/);
      try {
        switch (name) {
          case "help":     print(t("termHelp")); break;
          case "clear":    out.empty(); break;
          case "status": { const s = await g.statusText(); print(s || t("clean")); break; }
          case "log": {
            const n = Math.min(parseInt(args[0] ?? "10", 10) || 10, 50);
            const commits = await g.recentCommits(n);
            print(commits.map((c) =>
              `${c.oid.slice(0, 7)}  ${new Date(c.timestamp).toLocaleString()}  ${c.message}`
            ).join("\n") || t("historyEmpty"));
            break;
          }
          case "graph":
          case "tree": {
            const n = Math.min(parseInt(args[0] ?? "25", 10) || 25, 100);
            print(await g.graphText(n));
            break;
          }
          case "branch":   print(await g.listBranchesText()); break;
          case "checkout": if (args[0]) { await g.checkoutRef(args[0]); print(`→ ${args[0]}`); } break;
          case "restore":  if (args[0]) { await g.restoreCommit(args[0]); print(t("restored")); } break;
          case "sync":     await this.plugin.triggerManualSync(); print("✓"); break;
          case "force-delete":
            g.allowMassDeletion = true;
            try { await this.plugin.triggerManualSync(); } finally { g.allowMassDeletion = false; }
            print("✓");
            break;
          case "pull":     await g.pull(); print("✓"); break;
          case "push":     await g.pushNow(); print("✓"); break;
          case "remote":   print(g.getRemoteUrl()); break;
          default:         print(t("termUnknown"), "is-err");
        }
      } catch (err) {
        print(err instanceof Error ? err.message : String(err), "is-err");
      }
    };

    for (const [label, cmd] of [
      [t("syncNowBtn"), "sync"],
      ["Pull", "pull"],
      ["Push", "push"],
      [t("graphChip"), "graph"],
      [t("branches"), "branch"],
      ["Log", "log"],
      ["Status", "status"],
    ] as [string, string][]) {
      const chip = actions.createEl("button", { text: label, cls: "multisync-term-chip" });
      chip.addEventListener("click", () => void run(cmd));
    }

    // Prompt line
    const promptRow = term.createDiv({ cls: "multisync-term-prompt" });
    promptRow.createSpan({ text: "❯", cls: "multisync-term-caret" });
    const input = promptRow.createEl("input", { type: "text", cls: "multisync-term-input" });
    input.placeholder = t("termPlaceholder");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const value = input.value;
        input.value = "";
        if (value.trim()) {
          this.termHistory.push(value);
          this.termHistoryIdx = this.termHistory.length;
        }
        void run(value);
      } else if (e.key === "ArrowUp") {
        if (this.termHistoryIdx > 0) {
          this.termHistoryIdx--;
          input.value = this.termHistory[this.termHistoryIdx] ?? "";
        }
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        if (this.termHistoryIdx < this.termHistory.length) {
          this.termHistoryIdx++;
          input.value = this.termHistory[this.termHistoryIdx] ?? "";
        }
        e.preventDefault();
      }
    });

    print(t("termHelp"));
  }

  // ══ Advanced access ════════════════════════════════════════════════════════

  /**
   * Collapsed by default so the main UI stays minimal. Lets the user avoid
   * the built-in OAuth app entirely: their own OAuth app, or a personal
   * access token scoped to a single repo.
   */
  private displayAdvancedSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    const details = containerEl.createEl("details", { cls: "multisync-advanced" });
    details.createEl("summary", { text: t("advanced") });

    new Setting(details)
      .setName(t("languageOptionName"))
      .setDesc(t("languageOptionDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("en", "English")
          .addOption("ru", "Русский")
          .setValue(getLang())
          .onChange(async (val: Lang) => {
            this.plugin.settings.language = val;
            setLang(val);
            await this.plugin.saveSettings();
            this.plugin.setStatus("idle");
            this.display();
          });
      });

    new Setting(details)
      .setName(t("clientId"))
      .setDesc(t("clientIdDesc"))
      .addText((el) =>
        el
          .setPlaceholder(CLIENT_ID)
          .setValue(settings.customClientId)
          .onChange(async (val) => {
            settings.customClientId = val.trim();
            await this.plugin.saveSettings();
          })
      );

    let patValue = "";
    new Setting(details)
      .setName(t("pat"))
      .setDesc(t("patDesc"))
      .addText((el) => {
        el.inputEl.type = "password";
        el.setPlaceholder("github_pat_… / ghp_…").onChange((val) => {
          patValue = val.trim();
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText(t("connect"))
          .setCta()
          .onClick(async () => {
            if (!patValue) {
              new Notice(t("pasteToken"));
              return;
            }
            btn.setButtonText(t("connectingBtn")).setDisabled(true);
            try {
              const user = await getAuthenticatedUser(patValue);
              this.plugin.settings.githubToken    = patValue;
              this.plugin.settings.githubUsername = user.login;
              await this.plugin.initializeRepo(patValue, user.login);
              await this.plugin.saveSettings();
              new Notice(`${t("tokenConnected")} @${user.login}.`);
              this.display();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`${t("tokenFailed")}: ${msg}`);
              btn.setButtonText(t("connect")).setDisabled(false);
            }
          })
      );
  }

  // ══ Device flow ════════════════════════════════════════════════════════════

  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    btn.setButtonText(t("connectingBtn")).setDisabled(true);

    const clientId = this.plugin.settings.customClientId || CLIENT_ID;

    try {
      const deviceFlow = await requestDeviceCode(clientId);

      // Show the user their one-time code (drop a stale panel from a retry)
      this.containerEl.querySelector(".multisync-device-modal")?.remove();
      const modal = this.containerEl.createDiv({ cls: "multisync-device-modal" });
      modal.style.cssText =
        "background:var(--background-secondary);border-radius:8px;padding:16px;" +
        "margin-top:12px;text-align:center;";
      modal.createEl("p", { text: t("openUrl") });
      const link = modal.createEl("a", {
        text: deviceFlow.verification_uri,
        href: deviceFlow.verification_uri,
      });
      link.style.display = "block";
      const codeEl = modal.createEl("h1", {
        text: deviceFlow.user_code,
        cls: "multisync-user-code",
      });
      // Explicit styling so the code is visible regardless of Obsidian theme
      codeEl.style.cssText =
        "font-size:2rem;letter-spacing:0.25em;font-weight:700;" +
        "color:var(--text-normal);background:var(--background-primary);" +
        "border:2px solid var(--interactive-accent);border-radius:6px;" +
        "padding:8px 24px;display:inline-block;margin:12px auto;font-family:monospace;" +
        "user-select:text;cursor:copy;";

      const copyCode = async () => {
        try {
          await navigator.clipboard.writeText(deviceFlow.user_code);
          new Notice(t("codeCopied"));
        } catch {
          new Notice(t("copyFailed"));
        }
      };
      codeEl.title = t("clickToCopy");
      codeEl.addEventListener("click", copyCode);

      const copyBtn = modal.createEl("button", { text: t("copyCode") });
      copyBtn.addEventListener("click", copyCode);

      modal.createEl("p", {
        text: t("waiting"),
        cls: "setting-item-description",
      });

      // Restore button so the user can cancel / retry while waiting
      btn.setButtonText(t("cancel")).setDisabled(false);

      // Open browser automatically
      window.open(deviceFlow.verification_uri, "_blank");

      // Poll until approved
      const token = await pollForToken(
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in,
        undefined,
        clientId
      );

      modal.remove();

      // Get user info
      const user = await getAuthenticatedUser(token);
      this.plugin.settings.githubToken    = token;
      this.plugin.settings.githubUsername = user.login;

      // Initialise the repo
      await this.plugin.initializeRepo(token, user.login);

      await this.plugin.saveSettings();
      new Notice(`${t("connectedAs")} @${user.login}. ${t("syncStarted")}`);
      this.display();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Remove the code panel if it's still visible
      this.containerEl.querySelector(".multisync-device-modal")?.remove();
      new Notice(`${t("connectionFailed")}: ${msg}`);
      btn.setButtonText(t("connectBtn")).setDisabled(false);
    }
  }
}
