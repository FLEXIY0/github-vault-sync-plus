import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

// Load .env file (dev) — in CI/production set CLIENT_ID as a real env var
function loadEnv() {
  try {
    const envPath = resolve(__dirname, ".env");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env not present — rely on actual environment variables
  }
}

loadEnv();

const clientId = process.env.CLIENT_ID;
if (!clientId || clientId === "your_github_oauth_client_id_here") {
  console.warn(
    "\x1b[33m[multisync] WARNING: CLIENT_ID is not set.\n" +
    "  Copy .env.example to .env and fill in your OAuth App Client ID.\x1b[0m"
  );
}

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
  // Inject the Client ID at build time so it is baked into main.js
  // and never read from the filesystem at runtime.
  define: {
    "process.env.CLIENT_ID": JSON.stringify(clientId ?? ""),
  },
});
