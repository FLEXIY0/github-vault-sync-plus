// Compares the paths the plugin hands to Obsidian's DataAdapter on desktop
// (basePath set) vs mobile (basePath undefined -> vaultPath "").
const { createFsAdapter } = require("./test-fs-adapter.js");

function recorder() {
  const seen = [];
  const rec = (name) => async (p) => { seen.push(`${name}(${JSON.stringify(p)})`); throw new Error("stop"); };
  return {
    seen,
    readBinary: rec("readBinary"),
    write: rec("write"),
    writeBinary: rec("writeBinary"),
    remove: rec("remove"),
    mkdir: async () => {},
    list: rec("list"),
    stat: rec("stat"),
  };
}

async function probe(label, vaultPath) {
  const a = recorder();
  const fs = createFsAdapter(a, vaultPath);
  const calls = [
    ["readFile .git/HEAD", () => fs.promises.readFile(`${vaultPath}/.git/HEAD`, { encoding: "utf8" })],
    ["stat note",          () => fs.promises.stat(`${vaultPath}/Notes/a.md`)],
    ["writeFile note",     () => fs.promises.writeFile(`${vaultPath}/Notes/a.md`, "x")],
    ["readdir root",       () => fs.promises.readdir(`${vaultPath}`)],
    ["readFile isogit",    () => fs.promises.readFile(`.git/config`, { encoding: "utf8" })],
  ];
  console.log(`\n--- ${label} (vaultPath = ${JSON.stringify(vaultPath)}) ---`);
  for (const [name, fn] of calls) {
    a.seen.length = 0;
    try { await fn(); } catch { /* recorder always throws */ }
    console.log(`  ${name.padEnd(20)} -> ${a.seen[0] ?? "(no adapter call)"}`);
  }
}

(async () => {
  await probe("DESKTOP", "/home/user/Vault");
  await probe("MOBILE", "");
})();
