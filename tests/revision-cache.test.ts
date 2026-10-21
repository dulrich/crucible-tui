import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DIR_ENTRY_RETENTION_MS, pruneStaleDirEntries, stripShaEntry } from "../scripts/revision";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "revision-cache-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeSha(name: string, withBinary: boolean): Promise<string> {
  const sha = join(root, name);
  await mkdir(join(sha, "tree", "crates"), { recursive: true });
  await writeFile(join(sha, "tree", "Cargo.toml"), "x");
  await mkdir(join(sha, "target", "release", "deps"), { recursive: true });
  await mkdir(join(sha, "target", "release", "build"), { recursive: true });
  await writeFile(join(sha, "target", ".rustc_info.json"), "{}");
  await writeFile(join(sha, "target", "release", "deps", "mdview-abc"), "BIN");
  await writeFile(join(sha, "target", "release", "mdview.d"), "d");
  if (withBinary) await writeFile(join(sha, "target", "release", "mdview"), "BIN");
  return sha;
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await tree(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("stripShaEntry", () => {
  test("keeps exactly target/release/mdview and its content", async () => {
    const sha = await fakeSha("a".repeat(40), true);
    await stripShaEntry(sha);
    expect(await tree(sha)).toEqual(["target/release/mdview"]);
    expect(await Bun.file(join(sha, "target", "release", "mdview")).text()).toBe("BIN");
  });

  test("strips nothing when the binary is missing", async () => {
    const sha = await fakeSha("b".repeat(40), false);
    const before = await tree(sha);
    await stripShaEntry(sha);
    expect(await tree(sha)).toEqual(before);
  });

  test("a symlinked tree is not followed", async () => {
    const sha = await fakeSha("c".repeat(40), true);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "k");
    await rm(join(sha, "tree"), { recursive: true });
    await symlink(outside, join(sha, "tree"));
    await stripShaEntry(sha);
    expect(await Bun.file(join(outside, "keep")).text()).toBe("k");
  });
});

describe("pruneStaleDirEntries", () => {
  const now = Date.now();
  const age = async (path: string, ms: number) => {
    const t = new Date(now - ms);
    await utimes(path, t, t);
  };

  test("removes old dir-* entries, keeps recent ones and the kept key even when old", async () => {
    for (const k of ["old", "recent", "keep"]) await mkdir(join(root, `dir-${k}`, "target"), { recursive: true });
    await age(join(root, "dir-old"), DIR_ENTRY_RETENTION_MS + 60_000);
    await age(join(root, "dir-keep"), DIR_ENTRY_RETENTION_MS * 3);
    await age(join(root, "dir-recent"), DIR_ENTRY_RETENTION_MS - 60_000);
    await pruneStaleDirEntries(root, now, "keep");
    expect(await readdir(root).then((n) => n.sort())).toEqual(["dir-keep", "dir-recent"]);
  });

  test("never touches non-dir-* entries or symlinked dir-* entries", async () => {
    const sha = await fakeSha("d".repeat(40), true);
    await age(sha, DIR_ENTRY_RETENTION_MS * 5);
    const outside = join(root, "elsewhere");
    await mkdir(outside);
    await symlink(outside, join(root, "dir-link"));
    await pruneStaleDirEntries(root, now, "none");
    expect((await stat(sha)).isDirectory()).toBe(true);
    expect((await stat(outside)).isDirectory()).toBe(true);
    expect(await readdir(root)).toContain("dir-link");
  });
});
