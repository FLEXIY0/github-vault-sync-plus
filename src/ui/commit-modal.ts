import { App, Modal } from "obsidian";
import type MultiSyncPlugin from "../main";
import { CommitInfo, FileChange } from "../sync/git-sync";
import { diffLines } from "./diff";
import { t } from "../i18n";

const TYPE_SYMBOL: Record<FileChange["type"], string> = {
  add: "+",
  del: "−",
  mod: "±",
};

/** Side panel for a commit: file list on top, per-file diff below */
export class CommitDetailModal extends Modal {
  private plugin: MultiSyncPlugin;
  private commit: CommitInfo;

  constructor(app: App, plugin: MultiSyncPlugin, commit: CommitInfo) {
    super(app);
    this.plugin = plugin;
    this.commit = commit;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("multisync-commit-modal");

    contentEl.createEl("h3", { text: this.commit.message });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `${this.commit.oid.slice(0, 7)} · ${new Date(this.commit.timestamp).toLocaleString()}`,
    });

    const chips  = contentEl.createDiv({ cls: "multisync-file-chips" });
    const diffEl = contentEl.createDiv({ cls: "multisync-diff" });
    diffEl.setText(t("loadingDiff"));

    const g = this.plugin.gitSync!;
    let changes: FileChange[];
    try {
      changes = await g.commitChanges(this.commit.oid);
    } catch {
      changes = [];
    }
    if (changes.length === 0) {
      diffEl.setText(t("noChanges"));
      return;
    }

    let active: HTMLElement | null = null;
    const show = async (change: FileChange, chip: HTMLElement) => {
      active?.removeClass("is-active");
      active = chip;
      chip.addClass("is-active");
      diffEl.empty();
      diffEl.setText(t("loadingDiff"));

      const parent = await g.parentOf(this.commit.oid);
      const before = change.type === "add" ? "" : (parent ? (await g.fileAt(parent, change.path)) ?? "" : "");
      const after  = change.type === "del" ? "" : (await g.fileAt(this.commit.oid, change.path)) ?? "";

      diffEl.empty();
      const lines = diffLines(before, after);
      if (!lines) {
        diffEl.setText(t("tooLarge"));
        return;
      }
      for (const line of lines) {
        const prefix = line.type === "add" ? "+ " : line.type === "del" ? "− " : "  ";
        diffEl.createDiv({
          cls: `multisync-diff-line is-${line.type}`,
          text: prefix + line.text,
        });
      }
    };

    changes.forEach((change, i) => {
      const chip = chips.createEl("button", {
        cls: `multisync-file-chip is-${change.type}`,
        text: `${TYPE_SYMBOL[change.type]} ${change.path}`,
      });
      chip.addEventListener("click", () => void show(change, chip));
      if (i === 0) void show(change, chip);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
