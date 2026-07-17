import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

esbuild.build({
  banner: { js: "/* obsidian-multisync */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Node builtins must NOT be external: Obsidian mobile has no Node runtime,
  // so require("buffer") etc. would fail there. Everything gets bundled, with
  // browser polyfills resolved from node_modules and globals shimmed below.
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
  ],
  platform: "browser",
  inject: ["./shims.js"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});
