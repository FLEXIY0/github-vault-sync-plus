// Shims for Node globals used by bundled dependencies (sha.js / safe-buffer).
// Injected by esbuild so the plugin works on Obsidian mobile, where there is
// no Node.js runtime. On desktop the real globals are used when available.
import { Buffer as BufferPolyfill } from "buffer";

export const Buffer =
  (typeof globalThis !== "undefined" && globalThis.Buffer) || BufferPolyfill;

export const process = (typeof globalThis !== "undefined" &&
  globalThis.process) || {
  env: {},
  platform: "linux",
  cwd: () => "/",
  nextTick: (fn, ...args) => {
    Promise.resolve().then(() => fn(...args));
  },
};
