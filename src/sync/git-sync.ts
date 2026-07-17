import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
  GITHUB_API_BASE,
} from "../constants";
import { ConflictFile, SyncResult } from "../types";

// Custom HTTP client that uses Obsidian's requestUrl (mobile-safe, bypasses CORS)
const gitHttp = {
  async request({ url, method, headers, body }: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
  }) {
    let bodyBuffer: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      bodyBuffer = merged.buffer;
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuffer,
      throw: false,
    });

    const arrayBuffer = response.arrayBuffer;
    async function* responseBody() {
      yield new Uint8Array(arrayBuffer);
    }

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: "OK",
      body: responseBody(),
      headers: response.headers as Record<string, string>,
    };
  },
};

/**
 * Reports overall sync progress to the UI.
 * `percent` is 0–100, or undefined when progress is indeterminate.
 */
export type ProgressReporter = (percent: number | undefined, phase?: string) => void;

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private repoName: string;
  private remoteUrl: string;

  /**
   * Shared isomorphic-git object cache. Git objects are content-addressed and
   * immutable, so reusing one cache across all operations is safe and avoids
   * re-reading/re-parsing .git on every command — a large win on mobile where
   * each fs call crosses into native code.
   */
  private cache: Record<string, unknown> = {};

  // Lightweight remote-head check state (ETag lets GitHub answer 304 for free)
  private branchEtag: string | null = null;
  private lastRemoteSha: string | null = null;

  /** Optional UI progress hook — safe to leave unset */
  onProgress: ProgressReporter | null = null;

  private report(percent: number | undefined, phase?: string): void {
    try {
      this.onProgress?.(percent, phase);
    } catch {
      /* UI errors must never break a sync */
    }
  }

  /**
   * Maps isomorphic-git onProgress events ({phase, loaded, total}) into the
   * [base, base+span] slice of the overall percentage.
   */
  private netProgress(base: number, span: number) {
    return ({ phase, loaded, total }: { phase: string; loaded?: number; total?: number }) => {
      const frac = total && loaded !== undefined ? Math.min(loaded / total, 1) : 0;
      this.report(base + frac * span, phase);
    };
  }

  constructor(
    adapter: DataAdapter,
    vaultPath: string,
    token: string,
    username: string,
    repoName: string
  ) {
    this.fs = createFsAdapter(adapter, vaultPath);
    this.dir = vaultPath;
    this.token = token;
    this.username = username;
    this.repoName = repoName;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
  }

  /** Base options shared by ALL git operations (local and network) */
  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      cache: this.cache,
      author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
    };
  }

  /** resolveRef that returns null instead of throwing */
  private async resolveSafe(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
    } catch {
      return null;
    }
  }

  /**
   * Asks the GitHub API for the remote branch head SHA — one tiny request
   * instead of a full git fetch negotiation. Uses ETag so an unchanged branch
   * answers 304 (which doesn't count against the API rate limit).
   * Returns null when the answer is unknown (offline, 404, etc.) — callers
   * must fall back to a real fetch in that case.
   */
  private async remoteHead(): Promise<string | null> {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
      };
      if (this.branchEtag) headers["If-None-Match"] = this.branchEtag;

      const resp = await requestUrl({
        url: `${GITHUB_API_BASE}/repos/${this.username}/${this.repoName}/branches/${DEFAULT_BRANCH}`,
        method: "GET",
        headers,
        throw: false,
      });

      if (resp.status === 304) return this.lastRemoteSha;
      if (resp.status !== 200) return null;

      this.branchEtag = resp.headers["etag"] ?? resp.headers["ETag"] ?? null;
      const body = resp.json as { commit?: { sha?: string } };
      this.lastRemoteSha = body.commit?.sha ?? null;
      return this.lastRemoteSha;
    } catch {
      return null;
    }
  }

  /**
   * Extra options for NETWORK operations (push / fetch / clone).
   *
   * isomorphic-git strips credentials from remote URLs before sending requests.
   * We must supply them via `onAuth` so every push/fetch is authenticated.
   * We also pass `url` directly so the library does not have to read `.git/config`.
   */
  private netOpts() {
    const token = this.token;
    const username = this.username;
    return {
      ...this.gitOpts(),
      url: this.remoteUrl,
      onAuth: () => ({ username, password: token }),
      onAuthFailure: () => {
        throw new Error("GitHub authentication failed. Please reconnect your account in MultiSync settings.");
      },
    };
  }

  /** Returns true if .git exists and HEAD resolves (repo is initialised) */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if refs/heads/main exists (at least one commit has been made).
   * Returns false on a fresh git.init with no commits (unborn branch).
   */
  async hasLocalBranch(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch from origin. Returns the FETCH_HEAD oid when remote has commits,
   * or null when the remote is empty or unreachable.
   */
  private async safeFetch(onProgress?: ReturnType<GitSync["netProgress"]>): Promise<string | null> {
    try {
      await git.fetch({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        singleBranch: true,
        onProgress,
      });
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "FETCH_HEAD" });
    } catch {
      return null;
    }
  }

  /**
   * Clone the remote into the vault directory.
   * Returns true if the clone produced a usable local branch (non-empty remote).
   */
  async clone(): Promise<boolean> {
    this.report(undefined, "clone");
    await git.clone({
      ...this.netOpts(),
      singleBranch: true,
      depth: 1,
      onProgress: this.netProgress(0, 95),
    });
    this.report(100, "clone");
    return this.hasLocalBranch();
  }

  /**
   * First-time setup: init locally (if needed), commit everything, push.
   * Safe to call on a partially-initialised repo (retry after failure).
   */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    const alreadyInited = await this.isInitialized();
    if (!alreadyInited) {
      await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
    }

    // Stage all vault files — batch first, per-file fallback so one bad file
    // doesn't block the rest
    if (vaultFiles.length > 0) {
      try {
        await git.add({ ...this.gitOpts(), filepath: vaultFiles });
        this.report(40, "stage");
      } catch {
        let staged = 0;
        for (const file of vaultFiles) {
          try {
            await git.add({ ...this.gitOpts(), filepath: file });
          } catch {
            // Skip un-stageable files (binary, permission issues, etc.)
          }
          staged++;
          this.report((staged / vaultFiles.length) * 40, "stage");
        }
      }
    }

    const localBranchExists = await this.hasLocalBranch();
    if (!localBranchExists) {
      // First-ever commit — create it unconditionally so refs/heads/main is written
      // even when the vault is empty.
      await git.commit({
        ...this.gitOpts(),
        message: "sync: initial vault snapshot",
      });
    } else {
      // Subsequent call (retry) — only commit if something changed
      const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      const dirty = status.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
      if (dirty) {
        await git.commit({
          ...this.gitOpts(),
          message: "sync: initial vault snapshot",
        });
      }
    }

    // Set up remote (delete+re-add to ensure correct fetch refspec)
    try {
      await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
    } catch { /* didn't exist yet */ }
    await git.addRemote({
      fs: this.fs,
      dir: this.dir,
      remote: "origin",
      url: this.remoteUrl,
    });

    this.report(50, "push");
    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
      force: false,
      onProgress: this.netProgress(50, 50),
    });
    this.report(100, "push");
  }

  /**
   * Full sync cycle — runs on every file change and manual sync trigger.
   *
   * Steps (each individually guarded to prevent one failure cascading):
   *   1. Stage all changed files
   *   2. Commit if dirty  (creates refs/heads/main on first run)
   *   3. Fetch from remote
   *   4. Merge FETCH_HEAD into local branch  (skipped if remote is empty)
   *   5. Detect conflicts
   *   6. Push  (skipped if conflicts or no local branch yet)
   */
  async sync(changedFiles: string[]): Promise<SyncResult> {
    const conflicts: ConflictFile[] = [];

    try {
      // Kick off the remote-head check now so the network roundtrip overlaps
      // with the local staging work below.
      const remoteShaPromise = this.remoteHead();

      // ── 1. Scan + stage ──────────────────────────────────────────────────────
      // Overall progress budget: stage 0-30, commit 30-35, fetch 35-60,
      // merge 60-70, conflict scan 70-75, push 75-100.
      // One statusMatrix limited to the changed files drives both staging and
      // the dirty check — instead of hashing the whole vault twice.
      let toAdd: string[] = [];
      let toRemove: string[] = [];
      let scanned = true;
      try {
        const matrix = await git.statusMatrix({
          ...this.gitOpts(),
          filepaths: changedFiles.length > 0 ? changedFiles : undefined,
        });
        for (const [filepath, head, workdir, stage] of matrix) {
          if (head === 1 && workdir === 1 && stage === 1) continue; // unmodified
          if (workdir === 0) toRemove.push(filepath);
          else toAdd.push(filepath);
        }
      } catch {
        // statusMatrix can throw on an unborn branch — stage everything we were given
        scanned = false;
        toAdd = changedFiles;
        toRemove = [];
      }

      const totalOps = toAdd.length + toRemove.length;
      let staged = 0;
      if (toAdd.length > 0) {
        try {
          // Batch add — one index rewrite instead of one per file
          await git.add({ ...this.gitOpts(), filepath: toAdd });
          staged += toAdd.length;
          this.report((staged / totalOps) * 30, "stage");
        } catch {
          // Fall back to per-file staging so one bad file doesn't block the rest
          for (const file of toAdd) {
            try {
              await git.add({ ...this.gitOpts(), filepath: file });
            } catch {
              try {
                await git.remove({ ...this.gitOpts(), filepath: file });
              } catch { /* skip */ }
            }
            staged++;
            this.report((staged / totalOps) * 30, "stage");
          }
        }
      }
      for (const file of toRemove) {
        try {
          await git.remove({ ...this.gitOpts(), filepath: file });
        } catch { /* untracked — nothing to remove */ }
        staged++;
        this.report((staged / totalOps) * 30, "stage");
      }

      // ── 2. Commit if dirty ───────────────────────────────────────────────────
      const hasDirty = scanned ? totalOps > 0 : changedFiles.length > 0;
      if (hasDirty) {
        this.report(30, "commit");
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        await git.commit({
          ...this.gitOpts(),
          message: `sync: ${now}`,
        });
        // refs/heads/main is now guaranteed to exist
      }

      // ── 3. Fetch — skipped when the remote hasn't moved ─────────────────────
      this.report(35, "check remote");
      const remoteSha  = await remoteShaPromise;
      const localHead  = await this.resolveSafe(DEFAULT_BRANCH);
      const originMain = await this.resolveSafe(`refs/remotes/origin/${DEFAULT_BRANCH}`);

      let fetchHead: string | null = null;
      if (remoteSha && (remoteSha === localHead || remoteSha === originMain)) {
        // Remote head is something we already have — no fetch, no merge needed
        this.report(70, "up to date");
      } else {
        fetchHead = await this.safeFetch(this.netProgress(35, 25));
      }

      // ── 4. Merge — a conflict throws MergeConflictError with the file list ──
      let merged = false;
      if (fetchHead && (await this.hasLocalBranch())) {
        const head = await this.resolveSafe(DEFAULT_BRANCH);
        if (fetchHead !== head) {
          this.report(60, "merge");
          try {
            await git.merge({
              ...this.gitOpts(),
              ours: DEFAULT_BRANCH,
              theirs: fetchHead,
              message: "sync: merge remote changes",
              fastForwardOnly: false,
            });
            merged = true;
          } catch (err) {
            if (err instanceof git.Errors.MergeConflictError) {
              for (const filepath of err.data.filepaths) {
                const ours   = await this.readFileContent(filepath);
                const theirs = await this.readRemoteFileContent(filepath);
                conflicts.push({ path: filepath, ours, theirs });
              }
            } else {
              throw err;
            }
          }
        }
      }

      // ── 5. Double-check for unmerged index entries after a clean merge ──────
      if (merged && conflicts.length === 0 && (await this.hasLocalBranch())) {
        this.report(70, "check");
        const statusAfter = await git.statusMatrix(this.gitOpts());
        for (const [filepath, , , stage] of statusAfter) {
          if (stage === 2) {
            const ours   = await this.readFileContent(filepath);
            const theirs = await this.readRemoteFileContent(filepath);
            conflicts.push({ path: filepath, ours, theirs });
          }
        }
      }

      // ── 6. Push — skipped when the remote is already at our head ────────────
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        const headAfter = await this.resolveSafe(DEFAULT_BRANCH);
        if (remoteSha && headAfter && headAfter === remoteSha) {
          // Nothing new locally and remote is identical — skip the roundtrip
        } else {
          this.report(75, "push");
          await git.push({
            ...this.netOpts(),
            ref: DEFAULT_BRANCH,
            onProgress: this.netProgress(75, 25),
          });
          // Remote now points at our head; remember it and drop the stale ETag
          this.lastRemoteSha = headAfter;
          this.branchEtag = null;
        }
      }

      this.report(100, "done");
      return { success: conflicts.length === 0, conflictFiles: conflicts };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, conflictFiles: [], error: msg };
    }
  }

  /** Resolve a conflict by writing resolved content, committing, and pushing */
  async resolveConflict(filepath: string, resolvedContent: string): Promise<void> {
    const fullPath = `${this.dir}/${filepath}`;
    await this.fs.promises.writeFile(fullPath, resolvedContent);
    await git.add({ ...this.gitOpts(), filepath });
    await git.commit({
      ...this.gitOpts(),
      message: `sync: resolve conflict in ${filepath}`,
    });
    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
    });
  }

  /**
   * Pull-only — used on vault open to get latest without pushing.
   * Uses explicit fetch + merge (not git.pull) for consistent error handling.
   */
  async pull(): Promise<void> {
    if (!(await this.hasLocalBranch())) return;

    // Cheap remote-head check first — most opens have nothing new to pull
    this.report(undefined, "check remote");
    const remoteSha  = await this.remoteHead();
    const localHead  = await this.resolveSafe(DEFAULT_BRANCH);
    const originMain = await this.resolveSafe(`refs/remotes/origin/${DEFAULT_BRANCH}`);
    if (remoteSha && (remoteSha === localHead || remoteSha === originMain)) {
      this.report(100, "done");
      return;
    }

    const fetchHead = await this.safeFetch(this.netProgress(0, 70));
    if (!fetchHead) return;

    if (fetchHead !== localHead) {
      this.report(80, "merge");
      await git.merge({
        ...this.gitOpts(),
        ours: DEFAULT_BRANCH,
        theirs: fetchHead,
        message: "sync: merge remote changes",
        fastForwardOnly: false,
      });
    }
    this.report(100, "done");
  }

  /** Recent commits on main, newest first (for the heatmap / console) */
  async recentCommits(depth = 500): Promise<{ oid: string; message: string; timestamp: number }[]> {
    try {
      const entries = await git.log({ ...this.gitOpts(), ref: DEFAULT_BRANCH, depth });
      return entries.map((e) => ({
        oid: e.oid,
        message: e.commit.message.split("\n")[0],
        timestamp: e.commit.committer.timestamp * 1000,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Restore the working tree to a past commit WITHOUT rewriting history:
   * checkout the old tree in place, record it as a new commit, push.
   * The pre-restore state stays in history and can be restored back.
   */
  async restoreCommit(oid: string): Promise<void> {
    await git.checkout({
      ...this.gitOpts(),
      ref: oid,
      force: true,
      noUpdateHead: true,
    });
    await git.commit({
      ...this.gitOpts(),
      message: `sync: restore ${oid.slice(0, 7)}`,
    });
    await git.push({ ...this.netOpts(), ref: DEFAULT_BRANCH });
  }

  /** "* main\n  feature-x" style branch listing */
  async listBranchesText(): Promise<string> {
    const branches = await git.listBranches({ fs: this.fs, dir: this.dir });
    let current: string | null = null;
    try { current = (await git.currentBranch({ fs: this.fs, dir: this.dir })) ?? null; } catch { /* detached */ }
    if (branches.length === 0) return "(no branches)";
    return branches.map((b) => (b === current ? `* ${b}` : `  ${b}`)).join("\n");
  }

  async checkoutRef(ref: string): Promise<void> {
    await git.checkout({ ...this.gitOpts(), ref });
  }

  getRemoteUrl(): string {
    return this.remoteUrl;
  }

  /** Human-readable list of added/modified/deleted files vs HEAD */
  async statusText(): Promise<string> {
    const matrix = await git.statusMatrix(this.gitOpts());
    const lines: string[] = [];
    for (const [filepath, head, workdir] of matrix) {
      if (head === 0 && workdir === 2) lines.push(`A  ${filepath}`);
      else if (head === 1 && workdir === 2) lines.push(`M  ${filepath}`);
      else if (head === 1 && workdir === 0) lines.push(`D  ${filepath}`);
    }
    if (lines.length === 0) return "";
    const shown = lines.slice(0, 30);
    if (lines.length > 30) shown.push(`… +${lines.length - 30}`);
    return shown.join("\n");
  }

  /** Bare push for the console */
  async pushNow(): Promise<void> {
    await git.push({ ...this.netOpts(), ref: DEFAULT_BRANCH });
  }

  private async readFileContent(filepath: string): Promise<string> {
    try {
      const buf = await this.fs.promises.readFile(
        `${this.dir}/${filepath}`,
        { encoding: "utf8" }
      );
      return buf as string;
    } catch {
      return "";
    }
  }

  private async readRemoteFileContent(filepath: string): Promise<string> {
    try {
      const remoteCommit = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid: remoteCommit,
        filepath,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }
}
