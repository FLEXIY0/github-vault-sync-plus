// Regression test for "Push rejected because it was not a simple fast-forward".
//
// Reproduces the state that produced it: refs/remotes/origin/main sits at the
// remote head (fetched earlier) while the local branch is still behind it,
// because a previous merge never completed. The old code treated "we know that
// commit" as "we are up to date", skipped the merge, and pushed a branch the
// server could only reject — on every sync from then on.
//
// Runs offline: remoteHead() and fetch both fail, so the sync must fall back to
// the ref it already has and merge that.
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

(async () => {
  const root = await nfs.mkdtemp(path.join(os.tmpdir(), "gvs-div-")).then((d) => d.replace(/\\/g, "/"));
  await git.init({ fs: fssync, dir: root, defaultBranch: "main" });
  const sync = new GitSync(mkAdapter(root), root, "tok", "user", "repo");
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok:", msg); };

  // c1: the commit both sides share
  await nfs.writeFile(path.join(root, "a.md"), "shared\n");
  await sync.sync(["a.md"]);
  const c1 = await git.resolveRef({ fs: fssync, dir: root, ref: "main" });

  // c2: what the other device pushed. Build it on main, then rewind main so the
  // branch is behind while origin/main stays at c2 — exactly the broken state.
  await nfs.writeFile(path.join(root, "theirs.md"), "from the other device\n");
  await sync.sync(["theirs.md"]);
  const c2 = await git.resolveRef({ fs: fssync, dir: root, ref: "main" });
  await git.writeRef({ fs: fssync, dir: root, ref: "refs/remotes/origin/main", value: c2, force: true });
  await git.writeRef({ fs: fssync, dir: root, ref: "refs/heads/main", value: c1, force: true });
  await nfs.rm(path.join(root, ".git/index"), { force: true });

  assert(c1 !== c2, "setup: local branch is behind the known remote head");

  // A local edit, then a sync — this is where the old code went straight to push
  await nfs.writeFile(path.join(root, "mine.md"), "written here\n");
  const result = await sync.sync(["mine.md"]);

  const head = await git.resolveRef({ fs: fssync, dir: root, ref: "main" });
  const contains = await git.isDescendent({ fs: fssync, dir: root, oid: head, ancestor: c2, depth: -1 })
    .catch(() => false);
  assert(contains, "remote commit was merged instead of being skipped");

  // Both sides' files must survive the reconciliation
  for (const f of ["a.md", "theirs.md", "mine.md"]) {
    const inTree = await git.readBlob({ fs: fssync, dir: root, oid: head, filepath: f })
      .then(() => true, () => false);
    assert(inTree, `${f} present after reconcile`);
  }

  // Offline, so the push itself cannot succeed — but it must not be what fails
  assert(!result.error || !/fast-forward/i.test(result.error),
    "no non-fast-forward error surfaced");

  console.log("DIVERGED OK");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
