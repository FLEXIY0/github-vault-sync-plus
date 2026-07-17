const nfs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const os = require("os");
const git = require("isomorphic-git");
const { GitSync } = require("./test-git-sync.js");

function mkAdapter(root) {
  const p = (r) => path.join(root, r);
  return {
    async readBinary(r) { const b = await nfs.readFile(p(r)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async writeBinary(r, ab) { await nfs.writeFile(p(r), Buffer.from(ab)); },
    async write(r, s) { await nfs.writeFile(p(r), s); },
    async read(r) { return nfs.readFile(p(r), "utf8"); },
    async remove(r) { await nfs.unlink(p(r)); },
    async mkdir(r) { await nfs.mkdir(p(r), { recursive: true }); },
    async list(r) {
      const e = await nfs.readdir(p(r), { withFileTypes: true });
      const pre = r && r !== "/" ? r.replace(/\/$/, "") + "/" : "";
      return { files: e.filter((x) => x.isFile()).map((x) => pre + x.name), folders: e.filter((x) => x.isDirectory()).map((x) => pre + x.name) };
    },
    async stat(r) { const s = await nfs.stat(p(r)); return { type: s.isDirectory() ? "folder" : "file", size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
  };
}

(async () => {
  const root = (await nfs.mkdtemp(path.join(os.tmpdir(), "gvs-guard-"))).replace(/\\/g, "/");
  const names = [];
  for (let i = 0; i < 15; i++) { names.push(`n${i}.md`); await nfs.writeFile(path.join(root, `n${i}.md`), `note ${i}`); }
  await git.init({ fs: fssync, dir: root, defaultBranch: "main" });
  const s = new GitSync(mkAdapter(root), root, "t", "u", "r");
  await s.sync(names);

  // Simulate a broken device: 12 of 15 files vanish
  for (let i = 0; i < 12; i++) await nfs.unlink(path.join(root, `n${i}.md`));
  const r = await s.sync(names);
  console.log("skippedDeletions:", r.skippedDeletions);
  const files = await git.listFiles({ fs: fssync, dir: root, ref: "main" });
  console.log("files still in HEAD:", files.length);
  if (r.skippedDeletions === 12 && files.length === 15) console.log("GUARD OK");
  else { console.log("GUARD FAIL"); process.exit(1); }

  // force-delete bypass
  s.allowMassDeletion = true;
  await s.sync(names);
  const after = await git.listFiles({ fs: fssync, dir: root, ref: "main" });
  console.log("after force-delete:", after.length, after.length === 3 ? "FORCE OK" : "FORCE FAIL");
  if (after.length !== 3) process.exit(1);
})();
