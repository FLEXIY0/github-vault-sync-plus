import { Plugin } from "obsidian";
import { SyncStatus } from "../types";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle:       "✓",
  pulling:    "↓ Syncing",
  pushing:    "↑ Syncing",
  conflict:   "⚠ Conflict",
  error:      "✗ Sync Error",
  connecting: "… Connecting",
};

const BUSY_STATUSES: SyncStatus[] = ["pulling", "pushing", "connecting"];

/** "now", "5m", "3h", "2d" — compact time since the given timestamp */
function formatAgo(ts: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export class StatusBarItem {
  private el: HTMLElement;
  private labelEl: HTMLElement;
  private barEl: HTMLElement;
  private fillEl: HTMLElement;
  private pctEl: HTMLElement;
  private status: SyncStatus = "idle";
  private getLastSync: () => number;

  constructor(plugin: Plugin, getLastSync: () => number) {
    this.getLastSync = getLastSync;
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
    this.status = status;
    const label = STATUS_ICONS[status];

    if (status === "idle") {
      const ago = formatAgo(this.getLastSync());
      this.labelEl.setText(ago ? `${label} ${ago}` : `${label} Synced`);
      const last = this.getLastSync();
      if (last) {
        const full = `Last synced: ${new Date(last).toLocaleString()}`;
        this.el.setAttribute("aria-label", full);
        this.el.setAttribute("title", full);
      }
    } else {
      this.labelEl.setText(detail ? `${label}: ${detail}` : label);
    }
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

  /** Re-render the idle "time since last sync" label (called on an interval) */
  refresh(): void {
    if (this.status === "idle") this.set("idle");
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
    if (phase && BUSY_STATUSES.includes(this.status)) {
      this.el.setAttribute("aria-label", phase);
      this.el.setAttribute("title", phase);
    }
  }

  onClick(handler: () => void): void {
    this.el.addEventListener("click", handler);
  }
}
