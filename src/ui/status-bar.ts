import { Plugin } from "obsidian";
import { SyncStatus } from "../types";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle:       "✓ MultiSync",
  pulling:    "↓ Syncing",
  pushing:    "↑ Syncing",
  conflict:   "⚠ Conflict",
  error:      "✗ Sync Error",
  connecting: "… Connecting",
};

const BUSY_STATUSES: SyncStatus[] = ["pulling", "pushing", "connecting"];

export class StatusBarItem {
  private el: HTMLElement;
  private labelEl: HTMLElement;
  private barEl: HTMLElement;
  private fillEl: HTMLElement;
  private pctEl: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("multisync-status");
    this.el.style.cursor = "pointer";

    this.labelEl = this.el.createSpan({ cls: "multisync-label" });
    this.barEl   = this.el.createDiv({ cls: "multisync-bar" });
    this.fillEl  = this.barEl.createDiv({ cls: "multisync-bar-fill" });
    this.pctEl   = this.el.createSpan({ cls: "multisync-pct" });

    this.set("idle");
  }

  set(status: SyncStatus, detail?: string): void {
    const label = STATUS_ICONS[status];
    this.labelEl.setText(detail ? `${label}: ${detail}` : label);
    this.el.setAttribute("data-sync-status", status);

    if (BUSY_STATUSES.includes(status)) {
      this.el.addClass("is-syncing");
      // No percent yet — start in indeterminate mode until progress arrives
      this.progress(undefined);
    } else {
      this.el.removeClass("is-syncing");
      this.progress(undefined);
      this.pctEl.setText("");
      this.barEl.removeClass("is-indeterminate");
    }
  }

  /**
   * Update the progress bar. `percent` 0–100 shows a filling bar with a
   * percentage label; undefined switches to an indeterminate sliding bar.
   */
  progress(percent: number | undefined, phase?: string): void {
    if (percent === undefined) {
      this.barEl.addClass("is-indeterminate");
      this.fillEl.style.width = "";
      this.pctEl.setText("");
    } else {
      const clamped = Math.max(0, Math.min(100, percent));
      this.barEl.removeClass("is-indeterminate");
      this.fillEl.style.width = `${clamped}%`;
      this.pctEl.setText(`${Math.round(clamped)}%`);
    }
    if (phase) {
      this.el.setAttribute("aria-label", phase);
      this.el.setAttribute("title", phase);
    }
  }

  onClick(handler: () => void): void {
    this.el.addEventListener("click", handler);
  }
}
