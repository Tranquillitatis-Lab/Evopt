import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, appendFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { openStore, defaultRunDirectory } from "../src/storage.js";

async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evopt-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("durably checkpoints state, journals contiguous snapshots, and resumes", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { calls: 0 }, false);
  store.state.calls = 2;
  await store.save();
  await store.close();
  const records = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.sequence), [1, 2]);
  const resumed = await openStore(dir, { calls: 999 }, true);
  assert.equal(resumed.state.calls, 2);
  await resumed.close();
});

test("excludes simultaneous writers and refuses fresh runs over existing evidence", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { value: 1 }, false);
  await assert.rejects(openStore(dir, {}, true), /locked/);
  await store.close();
  await assert.rejects(openStore(dir, {}, false), /already exists/);
  const resumed = await openStore(dir, {}, true);
  await resumed.close();
});

test("recovers missing checkpoint and discards an incomplete final journal record", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { pending: true }, false);
  await store.close();
  await unlink(join(dir, "state.json"));
  await appendFile(join(dir, "journal.jsonl"), '{"version":1,"sequence":2,"state":');
  const resumed = await openStore(dir, { pending: false }, true);
  assert.equal(resumed.state.pending, true);
  await resumed.save();
  await resumed.close();
  const reopened = await openStore(dir, { pending: false }, true);
  assert.equal(reopened.state.pending, true);
  await reopened.close();
});

test("replays durable reservation newer than checkpoint after interrupted replacement", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { pending: false }, false);
  await store.close();
  await appendFile(join(dir, "journal.jsonl"), `${JSON.stringify({ version: 1, sequence: 2, state: { pending: true } })}\n`);
  const resumed = await openStore(dir, { pending: false }, true);
  assert.equal(resumed.state.pending, true);
  await resumed.close();
});

test("rejects malformed completed journal records, including middle records", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, {}, false);
  await store.close();
  await appendFile(join(dir, "journal.jsonl"), `broken\n${JSON.stringify({ version: 1, sequence: 2, state: {} })}\n`);
  await assert.rejects(openStore(dir, {}, true), /Invalid JSON/);
});

test("rejects conflicting checkpoint and journal and missing resume state", async t => {
  const dir = await fixture(t);
  await assert.rejects(openStore(dir, {}, true), /without a complete/);
  const store = await openStore(dir, { value: 1 }, false);
  await store.close();
  await writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, sequence: 1, state: { value: 2 } }));
  await assert.rejects(openStore(dir, {}, true), /disagree/);
});

test("does not remove another owner's replacement lock", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, {}, false);
  await writeFile(join(dir, "run.lock"), JSON.stringify({ token: "another-owner" }));
  await store.close();
  assert.equal(JSON.parse(await readFile(join(dir, "run.lock"), "utf8")).token, "another-owner");
});

test("rejects journal gaps and checkpoints ahead of the journal", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, {}, false);
  await store.close();
  await appendFile(join(dir, "journal.jsonl"), `${JSON.stringify({ version: 1, sequence: 3, state: {} })}\n`);
  await assert.rejects(openStore(dir, {}, true), /not contiguous/);
  await writeFile(join(dir, "journal.jsonl"), `${JSON.stringify({ version: 1, sequence: 1, state: {} })}\n`);
  await writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, sequence: 2, state: {} }));
  await assert.rejects(openStore(dir, {}, true), /ahead/);
});

test("closing is idempotent and subsequent saves fail", async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, {}, false);
  await store.close();
  await store.close();
  await assert.rejects(store.save(), /closed/);
});

test("default run directories are distinct absolute paths", () => {
  const a = defaultRunDirectory();
  const b = defaultRunDirectory();
  assert.notEqual(a, b);
  assert.ok(isAbsolute(a));
  assert.match(a, /\.evopt[\\/]runs[\\/]/);
});
