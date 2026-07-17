// Smoke test of GitSync local logic (stage/commit) against real isomorphic-git,
// with an Obsidian DataAdapter mock over node fs and network disabled.
const nfs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const os = require("os");
const git = require("isomorphic-git");
const { GitSync } = require("./test-git-sync.js");

function mkAdapter(root) {
  const p = (rel) => path.join(root, rel);
  return {
    async readBinary(rel) {
      const b = await nfs.readFile(p(rel));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async writeBinary(rel, ab) { await nfs.writeFile(p(rel), Buffer.from(ab)); },
    async write(rel, s) { await nfs.writeFile(p(rel), s); },
    async read(rel) { return nfs.readFile(p(rel), "utf8"); },
    async remove(rel) { await nfs.unlink(p(rel)); },
    async mkdir(rel) { await nfs.mkdir(p(rel), { recursive: true }); },
    async list(rel) {
      const entries = await nfs.readdir(p(rel), { withFileTypes: true });
      const prefix = rel && rel !== "/" ? rel.replace(/\/$/, "") + "/" : "";
      return {
        files: entries.filter((e) => e.isFile()).map((e) => prefix + e.name),
        folders: entries.filter((e) => e.isDirectory()).map((e) => prefix + e.name),
      };
    },
    async stat(rel) {
      const s = await nfs.stat(p(rel));
      return { type: s.isDirectory() ? "folder" : "file", size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
    },
  };
}

async function commitCount(dir) {
  try { return (await git.log({ fs: fssync, dir, ref: "main" })).length; }
  catch { return 0; }
}

(async () => {
  const root = await nfs.mkdtemp(path.join(os.tmpdir(), "gvs-test-")).then((d) => d.replace(/\\/g, "/"));
  await nfs.writeFile(path.join(root, "a.md"), "# Note A\n");
  await nfs.writeFile(path.join(root, "b.md"), "# Note B\n");
  await git.init({ fs: fssync, dir: root, defaultBranch: "main" });

  const sync = new GitSync(mkAdapter(root), root, "tok", "user", "repo");
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok:", msg); };

  // 1. First sync: stages + commits both files (push fails offline — expected)
  let r = await sync.sync(["a.md", "b.md"]);
  assert((await commitCount(root)) === 1, "first sync created 1 commit");

  // 2. No-change sync: must NOT create a commit
  r = await sync.sync(["a.md", "b.md"]);
  assert((await commitCount(root)) === 1, "no-change sync created no commit");

  // 3. Modify one file
  await nfs.writeFile(path.join(root, "a.md"), "# Note A v2\n");
  r = await sync.sync(["a.md"]);
  assert((await commitCount(root)) === 2, "modified file committed");
  const { blob } = await git.readBlob({
    fs: fssync, dir: root,
    oid: await git.resolveRef({ fs: fssync, dir: root, ref: "main" }),
    filepath: "a.md",
  });
  assert(new TextDecoder().decode(blob).includes("v2"), "commit contains new content");

  // 4. Delete a file
  await nfs.unlink(path.join(root, "b.md"));
  r = await sync.sync(["b.md"]);
  assert((await commitCount(root)) === 3, "deletion committed");
  let gone = false;
  try {
    await git.readBlob({
      fs: fssync, dir: root,
      oid: await git.resolveRef({ fs: fssync, dir: root, ref: "main" }),
      filepath: "b.md",
    });
  } catch { gone = true; }
  assert(gone, "deleted file removed from tree");

  console.log("ALL SMOKE TESTS PASSED");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
