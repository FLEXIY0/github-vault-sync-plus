# Obsidian MultiSync Plugin — Full Implementation Spec

## Goal
Build a production-ready Obsidian community plugin called **obsidian-multisync** that syncs
Obsidian vaults across unlimited devices (Windows / macOS / Linux desktop + iOS / Android mobile)
using GitHub as the storage backend.

- Each Obsidian vault gets **one private GitHub repo** (auto-created).
- Multiple vaults on the same account each get **their own repo**.
- All devices authenticate with the **same GitHub account** and share the same repo per vault.
- Developer pays **$0**. User pays **$0**.

---

## Architecture Summary

| Concern        | Solution                                              |
|----------------|-------------------------------------------------------|
| Auth           | GitHub OAuth Device Flow (no server, no callback URL) |
| Storage        | User's own private GitHub repo (one per vault)        |
| Sync engine    | isomorphic-git (pure JS — works on mobile)            |
| File system    | Custom adapter wrapping Obsidian's DataAdapter        |
| HTTP layer     | Obsidian's `requestUrl` API (works on mobile)         |
| Cost           | $0 forever at any scale                               |

---

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Obsidian Plugin API (obsidian npm package)
- **Sync**: isomorphic-git ^1.25.0
- **Bundler**: esbuild (standard for Obsidian plugins)
- **No backend server of any kind**

---

## Complete Project Structure

```
obsidian-multisync/
├── src/
│   ├── main.ts                   # Plugin entry point
│   ├── types.ts                  # All TypeScript interfaces & types
│   ├── constants.ts              # App-wide constants
│   ├── auth/
│   │   └── github-device.ts      # GitHub OAuth Device Flow
│   ├── github/
│   │   └── api.ts                # GitHub REST API wrapper
│   ├── sync/
│   │   ├── fs-adapter.ts         # Custom fs adapter for isomorphic-git
│   │   ├── git-sync.ts           # Core git operations (init/clone/pull/push)
│   │   ├── queue.ts              # Debounced sync queue with mutex
│   │   └── conflict.ts           # Conflict detection & resolution helpers
│   └── ui/
│       ├── settings-tab.ts       # Plugin settings UI
│       ├── conflict-modal.ts     # Side-by-side conflict resolution modal
│       └── status-bar.ts         # Status bar item (sync state indicator)
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── .gitignore
└── README.md
```

---

## Step 1 — Project Scaffold Files

### `manifest.json`
```json
{
  "id": "obsidian-multisync",
  "name": "MultiSync",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "Sync your vault across all devices using your own GitHub account. Free forever.",
  "author": "Your Name",
  "authorUrl": "https://github.com/yourusername/obsidian-multisync",
  "fundingUrl": "",
  "isDesktopOnly": false
}
```

### `package.json`
```json
{
  "name": "obsidian-multisync",
  "version": "1.0.0",
  "description": "Sync Obsidian vaults across devices via GitHub",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production"
  },
  "dependencies": {
    "isomorphic-git": "^1.25.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.20.0",
    "obsidian": "latest",
    "tslib": "^2.6.0",
    "typescript": "^5.3.0"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2018",
    "allowSyntheticDefaultImports": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "strictNullChecks": true,
    "lib": ["ES2018", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
```

### `esbuild.config.mjs`
```js
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

esbuild.build({
  banner: { js: "/* obsidian-multisync */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});
```

### `.gitignore`
```
node_modules/
main.js
*.js.map
dist/
```

---

## Step 2 — `src/constants.ts`

```typescript
// Register a free GitHub OAuth App at:
// https://github.com/settings/developers → OAuth Apps → New OAuth App
// Set Homepage URL to your plugin's GitHub repo URL
// Authorization callback URL: https://obsidian.md (placeholder — not used by Device Flow)
// After registering, paste the Client ID below.

export const CLIENT_ID = "YOUR_GITHUB_CLIENT_ID"; // ← replace after registering OAuth app

export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL  = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE   = "https://api.github.com";

export const PLUGIN_ID         = "obsidian-multisync";
export const GIT_AUTHOR_NAME   = "ObsidianMultiSync";
export const GIT_AUTHOR_EMAIL  = "sync@obsidian.local";
export const GIT_DIR           = ".git";            // stored inside vault root
export const SYNC_DEBOUNCE_MS  = 3000;              // 3 s after last keystroke
export const SYNC_ON_OPEN      = true;
export const SYNC_ON_CLOSE     = true;
export const DEFAULT_BRANCH    = "main";
```

---

## Step 3 — `src/types.ts`

Define every interface used across the plugin:

```typescript
export interface PluginSettings {
  githubToken: string;           // OAuth access token (stored locally)
  githubUsername: string;        // Authenticated GitHub username
  repoName: string;              // e.g. "obsidian-my-vault"
  autoSync: boolean;             // auto-sync on file changes
  syncIntervalMs: number;        // debounce window
  excludePatterns: string[];     // glob patterns to ignore (e.g. ".obsidian/workspace")
  lastSyncTime: number;          // unix timestamp of last successful sync
  commitMessageTemplate: string; // e.g. "sync: {{datetime}}"
}

export const DEFAULT_SETTINGS: PluginSettings = {
  githubToken: "",
  githubUsername: "",
  repoName: "",
  autoSync: true,
  syncIntervalMs: 3000,
  excludePatterns: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/plugins/*/data.json",
  ],
  lastSyncTime: 0,
  commitMessageTemplate: "sync: {{datetime}}",
};

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
}

export type SyncStatus =
  | "idle"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error"
  | "connecting";

export interface ConflictFile {
  path: string;
  ours: string;   // local file content
  theirs: string; // remote file content
}

export interface SyncResult {
  success: boolean;
  conflictFiles: ConflictFile[];
  error?: string;
}
```

---

## Step 4 — `src/auth/github-device.ts`

Implement the GitHub OAuth Device Flow. **No server or callback URL needed.**

```typescript
import { requestUrl } from "obsidian";
import {
  CLIENT_ID,
  GITHUB_DEVICE_URL,
  GITHUB_TOKEN_URL,
} from "../constants";
import { DeviceFlowResponse } from "../types";

/**
 * Step 1: Request a device code from GitHub.
 * Returns the user_code to display and the device_code to poll with.
 */
export async function requestDeviceCode(): Promise<DeviceFlowResponse> {
  const response = await requestUrl({
    url: GITHUB_DEVICE_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `client_id=${CLIENT_ID}&scope=repo`,
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`GitHub Device Flow failed: ${response.status}`);
  }

  return response.json as DeviceFlowResponse;
}

/**
 * Step 2: Poll GitHub until the user approves or the code expires.
 * Resolves with the access token on success.
 * Throws on expiry or denial.
 */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  onPollStart?: () => void
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = intervalSeconds * 1000;

  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Device code expired. Please try connecting again."));
        return;
      }

      onPollStart?.();

      const response = await requestUrl({
        url: GITHUB_TOKEN_URL,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `client_id=${CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
        throw: false,
      });

      const data = response.json as Record<string, string>;

      if (data.access_token) {
        resolve(data.access_token);
        return;
      }

      switch (data.error) {
        case "authorization_pending":
          setTimeout(poll, currentInterval);
          break;
        case "slow_down":
          currentInterval += 5000;
          setTimeout(poll, currentInterval);
          break;
        case "expired_token":
          reject(new Error("Code expired. Please reconnect."));
          break;
        case "access_denied":
          reject(new Error("Access denied. You cancelled the authorization."));
          break;
        default:
          reject(new Error(`Unknown error: ${data.error}`));
      }
    };

    setTimeout(poll, currentInterval);
  });
}
```

---

## Step 5 — `src/github/api.ts`

Wrapper around the GitHub REST API for all repo management.

```typescript
import { requestUrl } from "obsidian";
import { GITHUB_API_BASE } from "../constants";
import { GitHubUser, GitHubRepo } from "../types";

async function ghFetch<T>(
  path: string,
  token: string,
  options: { method?: string; body?: object } = {}
): Promise<T> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}${path}`,
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    throw: false,
  });

  if (response.status >= 400) {
    const err = response.json as { message?: string };
    throw new Error(`GitHub API error ${response.status}: ${err.message ?? "unknown"}`);
  }

  return response.json as T;
}

/** Get authenticated user info */
export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  return ghFetch<GitHubUser>("/user", token);
}

/** Check if a repo exists under the authenticated user */
export async function repoExists(
  token: string,
  username: string,
  repoName: string
): Promise<boolean> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}/repos/${username}/${repoName}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    throw: false,
  });
  return response.status === 200;
}

/** Create a new private repo for this vault */
export async function createRepo(
  token: string,
  repoName: string,
  description: string
): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>("/user/repos", token, {
    method: "POST",
    body: {
      name: repoName,
      description,
      private: true,
      auto_init: false,
    },
  });
}

/** Derive a safe repo name from the vault name */
export function vaultNameToRepoName(vaultName: string): string {
  return `obsidian-${vaultName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}
```

---

## Step 6 — `src/sync/fs-adapter.ts`

**Critical:** This bridges Obsidian's DataAdapter with isomorphic-git's expected Node.js `fs`
interface. Must work on both desktop (Electron) and mobile (iOS/Android).

```typescript
import { DataAdapter } from "obsidian";

type Stats = {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
};

/**
 * Creates a fs-like object for isomorphic-git that wraps Obsidian's DataAdapter.
 * Paths passed by isomorphic-git are ABSOLUTE (prefixed with vaultPath).
 * We strip the vaultPath prefix before calling Obsidian's adapter (which uses relative paths).
 */
export function createFsAdapter(adapter: DataAdapter, vaultPath: string) {
  /** Strip the vault root prefix so Obsidian adapter gets relative paths */
  function rel(absPath: string): string {
    const normalized = absPath.replace(/\\/g, "/");
    const base = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized.startsWith(base + "/")) {
      return normalized.slice(base.length + 1);
    }
    return normalized;
  }

  const promises = {
    async readFile(path: string, options?: { encoding?: string }): Promise<Buffer | string> {
      try {
        const content = await adapter.readBinary(rel(path));
        if (options?.encoding === "utf8") {
          return Buffer.from(content).toString("utf8");
        }
        return Buffer.from(content);
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void> {
      const relativePath = rel(path);
      // Ensure parent directory exists
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join("/");
        try { await adapter.mkdir(dir); } catch { /* already exists */ }
      }
      if (typeof data === "string") {
        await adapter.write(relativePath, data);
      } else {
        await adapter.writeBinary(relativePath, Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
    },

    async unlink(path: string): Promise<void> {
      try {
        await adapter.remove(rel(path));
      } catch {
        /* ignore if not found */
      }
    },

    async readdir(path: string): Promise<string[]> {
      try {
        const result = await adapter.list(rel(path));
        const files = result.files.map((f) => f.split("/").pop()!);
        const folders = result.folders.map((f) => f.split("/").pop()!);
        return [...folders, ...files];
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async mkdir(path: string, _options?: unknown): Promise<void> {
      try {
        await adapter.mkdir(rel(path));
      } catch {
        /* already exists — ignore */
      }
    },

    async rmdir(_path: string): Promise<void> {
      /* isomorphic-git calls rmdir on cleanup — safe to no-op for now */
    },

    async stat(path: string): Promise<Stats> {
      try {
        const s = await adapter.stat(rel(path));
        if (!s) throw new Error("no stat");
        return {
          type: s.type === "file" ? "file" : "dir",
          mode: s.type === "file" ? 0o100644 : 0o040755,
          size: s.size ?? 0,
          ino: 0,
          mtimeMs: s.mtime ?? Date.now(),
          ctimeMs: s.ctime ?? Date.now(),
          uid: 1,
          gid: 1,
          dev: 1,
        };
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async lstat(path: string): Promise<Stats> {
      return promises.stat(path);
    },

    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`EINVAL: readlink not supported '${path}'`), { code: "EINVAL" });
    },

    async symlink(): Promise<void> {
      throw Object.assign(new Error("EINVAL: symlink not supported"), { code: "EINVAL" });
    },

    async chmod(): Promise<void> {
      /* chmod is a no-op on mobile — isomorphic-git calls it but we can safely ignore */
    },
  };

  return { promises };
}
```

---

## Step 7 — `src/sync/git-sync.ts`

Core git operations. Every public function must be safe to call on mobile.

```typescript
import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
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

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: "OK",
      body: [new Uint8Array(response.arrayBuffer)][Symbol.iterator](),
      headers: response.headers,
    };
  },
};

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;      // absolute vault path
  private token: string;
  private remoteUrl: string;

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
    this.remoteUrl = `https://${username}:${token}@github.com/${username}/${repoName}.git`;
  }

  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
    };
  }

  /** Returns true if .git already exists inside the vault */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * First-time setup for a brand-new device with an EXISTING repo on GitHub.
   * Clones the remote into the vault directory.
   */
  async clone(): Promise<void> {
    await git.clone({
      ...this.gitOpts(),
      url: this.remoteUrl,
      singleBranch: true,
      depth: 1,
    });
  }

  /**
   * First-time setup when this is the FIRST device for this vault.
   * Initialises a local repo and pushes current vault contents.
   */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });

    // Stage all existing vault files
    for (const file of vaultFiles) {
      await git.add({ fs: this.fs, dir: this.dir, filepath: file });
    }

    await git.commit({
      ...this.gitOpts(),
      message: "sync: initial vault snapshot",
    });

    await git.addRemote({
      fs: this.fs,
      dir: this.dir,
      remote: "origin",
      url: this.remoteUrl,
    });

    await git.push({
      ...this.gitOpts(),
      remote: "origin",
      ref: DEFAULT_BRANCH,
      force: false,
    });
  }

  /**
   * Full sync cycle:
   * 1. Stage locally changed files
   * 2. Pull (fetch + merge) from remote
   * 3. Detect conflicts
   * 4. Push merged result
   *
   * Returns a SyncResult describing what happened.
   */
  async sync(changedFiles: string[]): Promise<SyncResult> {
    const conflicts: ConflictFile[] = [];

    try {
      // Stage local changes
      for (const file of changedFiles) {
        try {
          await git.add({ fs: this.fs, dir: this.dir, filepath: file });
        } catch {
          /* file may have been deleted — handle below */
          await git.remove({ fs: this.fs, dir: this.dir, filepath: file });
        }
      }

      if (changedFiles.length > 0) {
        const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        const dirty = status.filter(([, head, workdir, stage]) =>
          head !== 1 || workdir !== 1 || stage !== 1
        );
        if (dirty.length > 0) {
          const now = new Date().toISOString().replace("T", " ").slice(0, 19);
          await git.commit({
            ...this.gitOpts(),
            message: `sync: ${now}`,
          });
        }
      }

      // Pull remote changes
      const pullResult = await git.pull({
        ...this.gitOpts(),
        remote: "origin",
        ref: DEFAULT_BRANCH,
        singleBranch: true,
        fastForwardOnly: false,
      });

      // Check for unresolved conflicts after merge
      const statusAfterPull = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      for (const [filepath, head, workdir, stage] of statusAfterPull) {
        // stage === 2 means conflict
        if (stage === 2 || (head === 0 && workdir === 2 && stage === 0)) {
          // Both sides modified — read both versions
          const ours   = await this.readFileContent(filepath);
          const theirs = await this.readRemoteFileContent(filepath);
          conflicts.push({ path: filepath, ours, theirs });
        }
      }

      if (conflicts.length === 0) {
        // Clean — push
        await git.push({
          ...this.gitOpts(),
          remote: "origin",
          ref: DEFAULT_BRANCH,
        });
      }

      return { success: conflicts.length === 0, conflictFiles: conflicts };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, conflictFiles: [], error: msg };
    }
  }

  /** Resolve a conflict by accepting a specific version, then push */
  async resolveConflict(filepath: string, resolvedContent: string): Promise<void> {
    // Write resolved content
    const fullPath = `${this.dir}/${filepath}`;
    await this.fs.promises.writeFile(fullPath, resolvedContent);
    await git.add({ fs: this.fs, dir: this.dir, filepath });
    await git.commit({
      ...this.gitOpts(),
      message: `sync: resolve conflict in ${filepath}`,
    });
    await git.push({
      ...this.gitOpts(),
      remote: "origin",
      ref: DEFAULT_BRANCH,
    });
  }

  /** Pull only — used on vault open to get latest without pushing */
  async pull(): Promise<void> {
    await git.pull({
      ...this.gitOpts(),
      remote: "origin",
      ref: DEFAULT_BRANCH,
      singleBranch: true,
      fastForwardOnly: false,
    });
  }

  private async readFileContent(filepath: string): Promise<string> {
    try {
      const buf = await this.fs.promises.readFile(`${this.dir}/${filepath}`, { encoding: "utf8" });
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
```

---

## Step 8 — `src/sync/queue.ts`

Debounced, serialised sync queue so concurrent file saves never race.

```typescript
import { SYNC_DEBOUNCE_MS } from "../constants";
import { GitSync } from "./git-sync";
import { SyncResult } from "../types";

type StatusCallback = (status: import("../types").SyncStatus, detail?: string) => void;

export class SyncQueue {
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private gitSync: GitSync;
  private onStatus: StatusCallback;

  constructor(gitSync: GitSync, onStatus: StatusCallback) {
    this.gitSync = gitSync;
    this.onStatus = onStatus;
  }

  /** Enqueue a changed file path. Debounces before triggering sync. */
  enqueue(filepath: string): void {
    this.pendingFiles.add(filepath);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), SYNC_DEBOUNCE_MS);
  }

  /** Immediately drain the queue (used on vault close). */
  async flushNow(): Promise<SyncResult | null> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    return this.flush();
  }

  private async flush(): Promise<SyncResult | null> {
    if (this.running || this.pendingFiles.size === 0) return null;

    this.running = true;
    const filesToSync = [...this.pendingFiles];
    this.pendingFiles.clear();

    try {
      this.onStatus("pushing");
      const result = await this.gitSync.sync(filesToSync);

      if (result.conflictFiles.length > 0) {
        this.onStatus("conflict");
      } else if (result.success) {
        this.onStatus("idle");
      } else {
        this.onStatus("error", result.error);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatus("error", msg);
      return { success: false, conflictFiles: [], error: msg };
    } finally {
      this.running = false;
      // If more files arrived while we were syncing, flush again
      if (this.pendingFiles.size > 0) {
        setTimeout(() => this.flush(), 500);
      }
    }
  }
}
```

---

## Step 9 — `src/sync/conflict.ts`

Helper to render a simple diff for the conflict modal.

```typescript
import { ConflictFile } from "../types";

/**
 * Produce a simple line-by-line diff summary between ours and theirs.
 * Used in the conflict modal to help the user decide.
 */
export function diffSummary(conflict: ConflictFile): string {
  const oursLines   = conflict.ours.split("\n");
  const theirsLines = conflict.theirs.split("\n");

  const maxLen = Math.max(oursLines.length, theirsLines.length);
  const diffLines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const a = oursLines[i]   ?? "";
    const b = theirsLines[i] ?? "";
    if (a !== b) {
      diffLines.push(`Line ${i + 1}:`);
      if (a) diffLines.push(`  - ${a}`);
      if (b) diffLines.push(`  + ${b}`);
    }
  }

  return diffLines.length > 0
    ? diffLines.join("\n")
    : "(files are identical — safe to accept either)";
}
```

---

## Step 10 — `src/ui/status-bar.ts`

Status bar item in the bottom-right of Obsidian showing live sync state.

```typescript
import { Plugin } from "obsidian";
import { SyncStatus } from "../types";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle:       "✓ MultiSync",
  pulling:    "↓ Syncing…",
  pushing:    "↑ Syncing…",
  conflict:   "⚠ Conflict",
  error:      "✗ Sync Error",
  connecting: "… Connecting",
};

export class StatusBarItem {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.style.cursor = "pointer";
    this.set("idle");
  }

  set(status: SyncStatus, detail?: string): void {
    const label = STATUS_ICONS[status];
    this.el.setText(detail ? `${label}: ${detail}` : label);
    this.el.setAttribute("data-sync-status", status);
  }

  onClick(handler: () => void): void {
    this.el.addEventListener("click", handler);
  }
}
```

---

## Step 11 — `src/ui/conflict-modal.ts`

Modal that appears when a merge conflict is detected. Shows both versions
side-by-side and lets the user choose, or manually edit.

```typescript
import { App, Modal, Setting, MarkdownRenderer, Component } from "obsidian";
import { ConflictFile } from "../types";
import { diffSummary } from "../sync/conflict";

type ResolveCallback = (filepath: string, resolvedContent: string) => Promise<void>;

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[];
  private currentIndex = 0;
  private onResolve: ResolveCallback;
  private component: Component;

  constructor(app: App, conflicts: ConflictFile[], onResolve: ResolveCallback) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
    this.component = new Component();
  }

  onOpen(): void {
    this.component.load();
    this.renderCurrent();
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }

  private renderCurrent(): void {
    const conflict = this.conflicts[this.currentIndex];
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", {
      text: `Sync Conflict (${this.currentIndex + 1} / ${this.conflicts.length})`,
    });
    contentEl.createEl("p", {
      text: `File: ${conflict.path}`,
      cls: "conflict-filepath",
    });

    // Diff summary
    const diffEl = contentEl.createEl("pre", { cls: "conflict-diff" });
    diffEl.style.cssText = "background:var(--background-secondary);padding:8px;border-radius:4px;overflow:auto;max-height:180px;font-size:12px;";
    diffEl.textContent = diffSummary(conflict);

    // Two-column layout
    const cols = contentEl.createDiv({ cls: "conflict-columns" });
    cols.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0;";

    // OURS
    const oursCol = cols.createDiv();
    oursCol.createEl("h4", { text: "Your version (this device)" });
    const oursPre = oursCol.createEl("pre");
    oursPre.style.cssText = "background:#1a3a1a;padding:8px;border-radius:4px;overflow:auto;max-height:260px;font-size:11px;white-space:pre-wrap;";
    oursPre.textContent = conflict.ours.slice(0, 2000) + (conflict.ours.length > 2000 ? "\n…(truncated)" : "");

    // THEIRS
    const theirsCol = cols.createDiv();
    theirsCol.createEl("h4", { text: "Remote version (other device)" });
    const theirsPre = theirsCol.createEl("pre");
    theirsPre.style.cssText = "background:#1a1a3a;padding:8px;border-radius:4px;overflow:auto;max-height:260px;font-size:11px;white-space:pre-wrap;";
    theirsPre.textContent = conflict.theirs.slice(0, 2000) + (conflict.theirs.length > 2000 ? "\n…(truncated)" : "");

    // Action buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Keep Mine").onClick(async () => {
          await this.resolve(conflict, conflict.ours);
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Keep Theirs").setCta().onClick(async () => {
          await this.resolve(conflict, conflict.theirs);
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Open in Editor").onClick(() => {
          this.close();
          this.app.workspace.openLinkText(conflict.path, "", true);
        })
      );
  }

  private async resolve(conflict: ConflictFile, content: string): Promise<void> {
    await this.onResolve(conflict.path, content);
    this.currentIndex++;
    if (this.currentIndex < this.conflicts.length) {
      this.renderCurrent();
    } else {
      this.close();
    }
  }
}
```

---

## Step 12 — `src/ui/settings-tab.ts`

Settings tab with GitHub connect/disconnect, sync options, and status.

```typescript
import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type MultiSyncPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { getAuthenticatedUser } from "../github/api";

export class MultiSyncSettingsTab extends PluginSettingTab {
  plugin: MultiSyncPlugin;

  constructor(app: App, plugin: MultiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "MultiSync Settings" });

    const settings = this.plugin.settings;

    // ── Account section ─────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "GitHub Account" });

    if (settings.githubToken && settings.githubUsername) {
      // Connected state
      new Setting(containerEl)
        .setName("Connected account")
        .setDesc(`Signed in as @${settings.githubUsername}`)
        .addButton((btn) =>
          btn.setButtonText("Disconnect").setWarning().onClick(async () => {
            settings.githubToken = "";
            settings.githubUsername = "";
            settings.repoName = "";
            await this.plugin.saveSettings();
            this.display();
            new Notice("Disconnected from GitHub.");
          })
        );

      new Setting(containerEl)
        .setName("Vault repo")
        .setDesc(`github.com/${settings.githubUsername}/${settings.repoName}`);
    } else {
      // Disconnected state
      new Setting(containerEl)
        .setName("Connect GitHub account")
        .setDesc("Authorise MultiSync to access your private repos. Opens a browser window.")
        .addButton((btn) => {
          btn.setButtonText("Connect GitHub").setCta().onClick(async () => {
            await this.startDeviceFlow(btn);
          });
        });
    }

    // ── Sync options ─────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync Options" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync when files are modified.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait this many milliseconds after the last edit before syncing.")
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
      .setName("Excluded patterns")
      .setDesc("One pattern per line. These files will never be synced.")
      .addTextArea((ta) =>
        ta
          .setValue(settings.excludePatterns.join("\n"))
          .onChange(async (val) => {
            settings.excludePatterns = val.split("\n").map((s) => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Manual sync ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Manual Sync" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Immediately push all local changes and pull remote changes.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          await this.plugin.triggerManualSync();
          new Notice("Sync complete.");
        })
      );

    // ── Last sync time ────────────────────────────────────────────────────────
    if (settings.lastSyncTime > 0) {
      const lastSync = new Date(settings.lastSyncTime).toLocaleString();
      containerEl.createEl("p", {
        text: `Last synced: ${lastSync}`,
        cls: "setting-item-description",
      });
    }
  }

  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    btn.setButtonText("Connecting…").setDisabled(true);

    try {
      const deviceFlow = await requestDeviceCode();

      // Show the user their one-time code
      const modal = this.containerEl.createDiv({ cls: "multisync-device-modal" });
      modal.style.cssText =
        "background:var(--background-secondary);border-radius:8px;padding:16px;margin-top:12px;text-align:center;";
      modal.createEl("p", { text: "Open this URL in your browser and enter the code below:" });
      const link = modal.createEl("a", {
        text: deviceFlow.verification_uri,
        href: deviceFlow.verification_uri,
      });
      link.style.display = "block";
      modal.createEl("h1", {
        text: deviceFlow.user_code,
        cls: "multisync-user-code",
      });
      modal.createEl("p", {
        text: "Waiting for you to approve in the browser…",
        cls: "setting-item-description",
      });

      // Open browser automatically
      window.open(deviceFlow.verification_uri, "_blank");

      // Poll until approved
      const token = await pollForToken(
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in
      );

      modal.remove();

      // Get user info
      const user = await getAuthenticatedUser(token);
      this.plugin.settings.githubToken    = token;
      this.plugin.settings.githubUsername = user.login;

      // Initialise the repo
      await this.plugin.initializeRepo(token, user.login);

      await this.plugin.saveSettings();
      new Notice(`✓ Connected as @${user.login}. Vault syncing started!`);
      this.display();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Connection failed: ${msg}`);
      btn.setButtonText("Connect GitHub").setDisabled(false);
    }
  }
}
```

---

## Step 13 — `src/main.ts`

Plugin entry point. Wires everything together.

```typescript
import { Plugin, Notice, TFile, debounce } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile } from "./types";
import { MultiSyncSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";

export default class MultiSyncPlugin extends Plugin {
  settings!: PluginSettings;
  private statusBar!: StatusBarItem;
  private gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => this.triggerManualSync());

    this.addSettingTab(new MultiSyncSettingsTab(this.app, this));

    // Keyboard command
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
    });

    // Boot sync engine if already connected
    if (this.settings.githubToken && this.settings.githubUsername && this.settings.repoName) {
      await this.bootSyncEngine();
    }

    // Pull on open
    this.app.workspace.onLayoutReady(async () => {
      if (this.gitSync) {
        this.setStatus("pulling");
        try {
          await this.gitSync.pull();
          this.setStatus("idle");
        } catch (e) {
          this.setStatus("error", "Pull failed on open");
        }
      }
    });

    // Watch file changes
    this.registerEvent(
      this.app.vault.on("modify", (file: TFile) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TFile) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TFile) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (_file: TFile, oldPath: string) => {
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
  async initializeRepo(token: string, username: string): Promise<void> {
    this.setStatus("connecting");

    const vaultName = this.app.vault.getName();
    const repoName  = vaultNameToRepoName(vaultName);
    this.settings.repoName = repoName;

    const adapter   = this.app.vault.adapter;
    // @ts-ignore — Obsidian exposes basePath on FileSystemAdapter (desktop) and we use it for git dir
    const vaultPath: string = (adapter as any).basePath ?? "";

    const sync = new GitSync(adapter, vaultPath, token, username, repoName);

    const exists = await repoExists(token, username, repoName);
    const alreadyInit = await sync.isInitialized();

    if (!exists) {
      // Brand-new vault — create repo and push
      await createRepo(token, repoName, `Obsidian vault: ${vaultName}`);
      const allFiles = this.app.vault.getFiles().map((f) => f.path).filter((p) => !this.isExcluded(p));
      await sync.initAndPush(allFiles);
      new Notice(`Created private repo: ${username}/${repoName}`);
    } else if (!alreadyInit) {
      // Repo exists remotely, this is a new device — clone
      await sync.clone();
      new Notice(`Cloned repo: ${username}/${repoName}`);
    } else {
      // Already initialised locally — just make sure remote is correct
      new Notice(`Reconnected to: ${username}/${repoName}`);
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName } = this.settings;
    if (!githubToken || !githubUsername || !repoName) return;

    const adapter   = this.app.vault.adapter;
    // @ts-ignore
    const vaultPath: string = (adapter as any).basePath ?? "";

    this.gitSync = new GitSync(adapter, vaultPath, githubToken, githubUsername, repoName);
    this.syncQueue = new SyncQueue(this.gitSync, (status, detail) => {
      this.setStatus(status, detail);
      if (status === "idle") {
        this.settings.lastSyncTime = Date.now();
        this.saveSettings();
      }
    });
  }

  async triggerManualSync(): Promise<void> {
    if (!this.gitSync) {
      new Notice("MultiSync: not connected. Please connect your GitHub account in settings.");
      return;
    }

    this.setStatus("pulling");
    try {
      const allFiles = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

      const result = await this.gitSync.sync(allFiles);

      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict");
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice("✓ Vault synced successfully.");
      } else {
        this.setStatus("error", result.error);
        new Notice(`Sync error: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`Sync failed: ${msg}`);
    }
  }

  private showConflictModal(conflicts: ConflictFile[]): void {
    new ConflictModal(this.app, conflicts, async (filepath, resolved) => {
      await this.gitSync!.resolveConflict(filepath, resolved);
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
      this.setStatus("idle");
    }).open();
  }

  private isExcluded(filepath: string): boolean {
    return this.settings.excludePatterns.some((pattern) => {
      // Simple prefix/suffix glob matching
      const p = pattern.replace(/\*/g, ".*");
      return new RegExp(`^${p}$`).test(filepath);
    });
  }
}
```

---

## Step 14 — Build & Test Instructions

After implementing all files above, run:

```bash
npm install
npm run dev        # watch mode — builds on every save
```

To test:
1. Copy the built `main.js` + `manifest.json` into `.obsidian/plugins/obsidian-multisync/` inside a test vault.
2. Enable the plugin in Obsidian → Settings → Community plugins.
3. Go to Settings → MultiSync → Connect GitHub.
4. Approve in browser.
5. Verify private repo created on GitHub.
6. On a second device, install same plugin, connect same GitHub account → should clone automatically.
7. Edit a file on device 1 → verify it appears on device 2 within a few seconds after opening vault.

---

## Key Constraints to Maintain

- **Never** use `require('fs')` directly — always use the `fs-adapter` so mobile works.
- **Always** pull before push — this is enforced in `git-sync.ts::sync()`.
- **Always** use `requestUrl` from obsidian for HTTP — never `fetch` or `axios` directly.
- **Never** store the GitHub token anywhere other than `this.saveData()` (Obsidian's local plugin data).
- `isDesktopOnly: false` in manifest — the plugin must work on mobile.
