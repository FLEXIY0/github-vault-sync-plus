import { ItemView, WorkspaceLeaf } from "obsidian";
import type MultiSyncPlugin from "../main";
import { t } from "../i18n";

export const LOG_VIEW_TYPE = "git-sync-plus-log";

/** Sidebar view listing recent sync events, newest first */
export class SyncLogView extends ItemView {
  private plugin: MultiSyncPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: MultiSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("logTitle");
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.refresh();
  }

  refresh(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("multisync-log");

    const head = el.createDiv({ cls: "multisync-log-head" });
    head.createEl("h4", { text: t("logTitle") });
    const clear = head.createEl("button", { text: t("clearLog"), cls: "multisync-log-clear" });
    clear.addEventListener("click", async () => {
      this.plugin.settings.syncLog = [];
      await this.plugin.saveSettings();
      this.refresh();
    });

    const list = el.createDiv({ cls: "multisync-log-list" });
    const entries = [...this.plugin.settings.syncLog].reverse();
    if (entries.length === 0) {
      list.createEl("p", { text: t("logEmpty"), cls: "setting-item-description" });
      return;
    }

    let lastDay = "";
    for (const entry of entries) {
      const d = new Date(entry.time);
      const day = d.toLocaleDateString();
      if (day !== lastDay) {
        lastDay = day;
        list.createDiv({ cls: "multisync-log-day", text: day });
      }
      const row = list.createDiv({ cls: `multisync-log-row is-${entry.status}` });
      row.createSpan({ cls: "multisync-log-dot" });
      row.createSpan({
        cls: "multisync-log-time",
        text: d.toLocaleTimeString().slice(0, 5),
      });
      row.createSpan({ cls: "multisync-log-msg", text: entry.message });
    }
  }
}
