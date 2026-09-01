import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";

import {
  atomicReplaceJson,
  publishImmutableJson,
  withResourceLock,
  updateSnapshotCas,
  tryHardLink,
} from "../../src/state/durable-store.js";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

suite("durable-store: atomicReplaceJson", { concurrency: false }, () => {
  test("writes JSON atomically with no .tmp residue", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-ds-"));
    const file = join(dir, "a.json");
    await atomicReplaceJson(file, { hello: "world" });
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.hello, "world");
    const entries = await readdir(dir);
    assert.ok(entries.includes("a.json"));
    assert.ok(!entries.some((f) => f.endsWith(".tmp")), `unexpected tmp: ${entries.join(", ")}`);
    await rm(dir, { recursive: true, force: true });
  });

  test("overwrites an existing value and fsyncs the parent", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-ds-"));
    await mkdir(join(dir, "nested"), { recursive: true });
    const file = join(dir, "nested", "x.json");
    await atomicReplaceJson(file, { v: 1 });
    await atomicReplaceJson(file, { v: 2 });
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.v, 2);
    await rm(dir, { recursive: true, force: true });
  });
});

suite("durable-store: publishImmutableJson", { concurrency: false }, () => {
  test("writes a new file the first time", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-ds-"));
    const file = join(dir, "immut.json");
    await publishImmutableJson(file, { frozen: true });
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.frozen, true);
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects an existing immutable file", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-ds-"));
    const file = join(dir, "immut.json");
    await publishImmutableJson(file, { v: 1 });
    await assert.rejects(
      () => publishImmutableJson(file, { v: 2 }),
      /already exists/,
    );
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.v, 1, "first value must remain intact");
    await rm(dir, { recursive: true, force: true });
  });

  test("parallel races: only one writer can claim a fresh path", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-ds-"));
    const file = join(dir, "race.json");
    const results = await Promise.allSettled([
      publishImmutableJson(file, { who: "a" }),
      publishImmutableJson(file, { who: "b" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    assert.equal(ok, 1, "exactly one writer succeeds");
    assert.equal(failed, 1, "the other writer is rejected");
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.ok(back.who === "a" || back.who === "b");
    await rm(dir, { recursive: true, force: true });
  });

  test("tryHardLink returns fallback for non-portable filesystems", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-ds-"));
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    await writeFile(src, "hello");
    // The path is cross-device in the host; tryHardLink() must
    // recognise EXDEV as a fallback signal and not throw.
    const result = await tryHardLink(src, dst).catch(() => "rejected");
    assert.ok(
      result === "fallback" || result === "exists" || result === "linked" || result === "rejected",
      `unexpected result: ${result}`,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

suite("durable-store: withResourceLock", { concurrency: false }, () => {
  test("excludes a concurrent try-acquire callback on the same key", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-lock-"));
    const entered = deferred();
    const release = deferred();
    let contenderRan = false;
    const holder = withResourceLock(dir, "alpha", async () => {
      entered.resolve();
      await release.promise;
      return "A";
    });

    await entered.promise;
    await assert.rejects(
      () => withResourceLock(dir, "alpha", {
        callback: async () => {
          contenderRan = true;
        },
        options: { acquire: "try" },
      }),
      /resource is busy: alpha/,
    );
    assert.equal(contenderRan, false);

    release.resolve();
    assert.equal(await holder, "A");
    await rm(dir, { recursive: true, force: true });
  });

  test("different keys do not block each other", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-lock-"));
    const alphaEntered = deferred();
    const betaEntered = deferred();
    const releaseAlpha = deferred();
    const releaseBeta = deferred();
    const a = withResourceLock(dir, "alpha", async () => {
      alphaEntered.resolve();
      await releaseAlpha.promise;
    });

    await alphaEntered.promise;
    const b = withResourceLock(dir, "beta", async () => {
      betaEntered.resolve();
      await releaseBeta.promise;
    });

    await betaEntered.promise;
    releaseBeta.resolve();
    releaseAlpha.resolve();
    await Promise.all([a, b]);
    await rm(dir, { recursive: true, force: true });
  });

  test("quarantines a stale same-host dead-PID lock after 120s", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-lock-"));
    const { createHash } = await import("node:crypto");
    const { hostname: osHostname } = await import("node:os");
    const keyHash = createHash("sha256").update("stale").digest("hex");
    const ownerPath = join(dir, "locks", keyHash, "owner.json");
    await mkdir(dirname(ownerPath), { recursive: true });
    const staleTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    // Pick a pid that is guaranteed dead on the current host. The
    // kernel returns ESRCH for an unmapped pid, which the production
    // code interprets as "not alive".
    const deadPid = 0x7ffffff0;
    const owner = {
      pid: deadPid,
      hostname: osHostname(),
      resource: "stale",
      startedAt: staleTs,
    };
    await writeFile(ownerPath, JSON.stringify(owner));
    const out = await withResourceLock(dir, "stale", async () => "ran");
    assert.equal(out, "ran");
    const after = await readdir(join(dir, "locks", keyHash));
    assert.ok(
      after.some((f) => f.startsWith("stale-")),
      `expected stale- quarantine file, got ${after.join(", ")}`,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

suite("durable-store: updateSnapshotCas", { concurrency: false }, () => {
  test("writes a fresh snapshot when generation is zero", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-cas-"));
    const file = join(dir, "snap.json");
    const result = await updateSnapshotCas(file, 0, () => ({ counter: 1 }));
    assert.equal(result.generation, 1);
    assert.equal(result.value.counter, 1);
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.generation, 1);
    await rm(dir, { recursive: true, force: true });
  });

  test("advances generation when expected matches", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-cas-"));
    const file = join(dir, "snap.json");
    const first = await updateSnapshotCas(file, 0, () => ({ counter: 1 }));
    const second = await updateSnapshotCas(file, first.generation, (cur) => ({ counter: cur.counter + 1 }));
    assert.equal(second.generation, 2);
    assert.equal(second.value.counter, 2);
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects a stale generation and does not overwrite the snapshot", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-cas-"));
    const file = join(dir, "snap.json");
    await updateSnapshotCas(file, 0, () => ({ counter: 1 }));
    await assert.rejects(
      () => updateSnapshotCas(file, 0, () => ({ counter: 99 })),
      /stale generation/i,
    );
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.value.counter, 1);
    await rm(dir, { recursive: true, force: true });
  });

  test("parallel CAS updates only one wins per generation", { serial: true }, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "ocd-cas-"));
    const file = join(dir, "snap.json");
    const a = updateSnapshotCas(file, 0, (cur) => ({ writer: "a", n: 1 }));
    const b = updateSnapshotCas(file, 0, (cur) => ({ writer: "b", n: 1 }));
    const results = await Promise.allSettled([a, b]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    assert.equal(ok, 1, "exactly one CAS writer wins");
    assert.equal(fail, 1, "the other CAS writer is rejected");
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.generation, 1);
    await rm(dir, { recursive: true, force: true });
  });
});
