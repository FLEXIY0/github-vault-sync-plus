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
  const root = (await nfs.mkdtemp(path.join(os.tmpdir(), "gvs-conc-"))).replace(/\\/g, "/");
  const names = [];
  for (let i = 0; i < 20; i++) { names.push(`f${i}.md`); await nfs.writeFile(path.join(root, `f${i}.md`), `v0 ${i}`); }
  await git.init({ fs: fssync, dir: root, defaultBranch: "main" });
  const s = new GitSync(mkAdapter(root), root, "t", "u", "r");

  // Hammer: 6 concurrent operations that used to interleave writes to .git
  const jobs = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 20; i++) await nfs.writeFile(path.join(root, `f${i}.md`), `v${round + 1} ${i}`);
    jobs.push(s.sync(names));
    jobs.push(s.pull());
  }
  await Promise.allSettled(jobs);

  // .git must still be coherent: HEAD resolves, log works, tree is complete
  const head = fssync.readFileSync(path.join(root, ".git/HEAD"), "utf8").trim();
  const log = await git.log({ fs: fssync, dir: root, ref: "main" });
  const files = await git.listFiles({ fs: fssync, dir: root, ref: "main" });
  console.log("HEAD:", JSON.stringify(head));
  console.log("commits:", log.length, "files in HEAD:", files.length);
  if (head === "ref: refs/heads/main" && log.length >= 1 && files.length === 20) {
    console.log("CONCURRENCY OK");
  } else {
    console.log("CONCURRENCY FAIL");
    process.exit(1);
  }
})();
