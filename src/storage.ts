import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, truncate } from "node:fs/promises";
import { resolve, join } from "node:path";

export interface StateStore<T> {
  state: T;
  save(): Promise<void>;
  close(): Promise<void>;
}

interface Snapshot<T> {
  version: 1;
  sequence: number;
  state: T;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function decodeSnapshot<T>(text: string, location: string): Snapshot<T> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Invalid JSON in ${location}`); }
  if (!value || typeof value !== "object" ||
      (value as Snapshot<T>).version !== 1 ||
      !Number.isSafeInteger((value as Snapshot<T>).sequence) ||
      (value as Snapshot<T>).sequence < 1 ||
      !Object.hasOwn(value, "state")) {
    throw new Error(`Invalid snapshot in ${location}`);
  }
  return value as Snapshot<T>;
}

/** Each invocation gets its own local evidence directory unless a caller supplies one. */
export function defaultRunDirectory(): string {
  return resolve(".evopt", "runs", randomUUID());
}

/**
 * A locked, single-writer checkpoint and write-ahead journal. A completed journal
 * record is authoritative if an interruption left the checkpoint behind it.
 * Locks are never stolen automatically: an operator must first establish that
 * the previous writer is no longer running before removing a leftover lock.
 */
export async function openStore<T>(directory: string, initial: T, resume: boolean): Promise<StateStore<T>> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, "run.lock");
  const statePath = join(root, "state.json");
  const journalPath = join(root, "journal.jsonl");
  const token = randomUUID();
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Run is locked: ${lockPath}; never remove a lock without verifying its writer has stopped`);
    }
    throw error;
  }
  let closed = false;
  let poisoned = false;
  let saving = false;
  const release = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await lock.close();
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (owner.token === token) await unlink(lockPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  try {
    await lock.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
    await lock.sync();
    let checkpoint: Snapshot<T> | undefined;
    let journalText = "";
    try { checkpoint = decodeSnapshot<T>(await readFile(statePath, "utf8"), statePath); }
    catch (error) { if (!isMissing(error)) throw error; }
    try { journalText = await readFile(journalPath, "utf8"); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (!resume && (checkpoint || journalText.length > 0)) {
      throw new Error("Run evidence already exists; use explicit resume or a new run directory");
    }

    // Only newline-terminated records have completed the journal write. Discard
    // a partial final record; malformed completed records always fail closed.
    const completeEnd = journalText.lastIndexOf("\n") + 1;
    const completeText = journalText.slice(0, completeEnd);
    let latest: Snapshot<T> | undefined;
    for (const [index, line] of completeText.split("\n").slice(0, -1).entries()) {
      const entry = decodeSnapshot<T>(line, `${journalPath}:${index + 1}`);
      if (latest && entry.sequence !== latest.sequence + 1) {
        throw new Error("Journal sequence is not contiguous");
      }
      latest = entry;
    }
    if (checkpoint && latest && checkpoint.sequence === latest.sequence &&
        JSON.stringify(checkpoint.state) !== JSON.stringify(latest.state)) {
      throw new Error("Checkpoint and journal disagree at the same sequence");
    }
    if (checkpoint && latest && checkpoint.sequence > latest.sequence) {
      throw new Error("Checkpoint is ahead of its durable journal");
    }
    const recovered = latest && (!checkpoint || latest.sequence > checkpoint.sequence) ? latest : checkpoint;
    if (resume && !recovered) throw new Error("Cannot resume a run without a complete saved snapshot");
    if (journalText.length !== completeEnd) {
      await truncate(journalPath, Buffer.byteLength(completeText));
    }
    let sequence = recovered?.sequence ?? 0;
    const store: StateStore<T> = {
      state: recovered ? recovered.state : initial,
      async save() {
        if (closed) throw new Error("State store is closed");
        if (poisoned) throw new Error("Previous persistence failed; close and recover the run before continuing");
        if (saving) throw new Error("Concurrent saves are not supported");
        saving = true;
        const nextSequence = sequence + 1;
        const tempPath = join(root, `.state-${token}-${nextSequence}.tmp`);
        try {
          if (!Number.isSafeInteger(nextSequence)) throw new Error("Journal sequence overflow");
          const snapshot: Snapshot<T> = { version: 1, sequence: nextSequence, state: store.state };
          const encoded = JSON.stringify(snapshot);
          // Reject non-serializable top-level state before touching evidence.
          decodeSnapshot<T>(encoded, "pending snapshot");
          const journal = await open(journalPath, "a", 0o600);
          try { await journal.writeFile(`${encoded}\n`); await journal.sync(); }
          finally { await journal.close(); }
          const temp = await open(tempPath, "wx", 0o600);
          try { await temp.writeFile(`${encoded}\n`); await temp.sync(); }
          finally { await temp.close(); }
          await rename(tempPath, statePath);
          sequence = nextSequence;
        } catch (error) {
          poisoned = true;
          try { await unlink(tempPath); } catch (cleanupError) { if (!isMissing(cleanupError)) { /* Preserve the original write error. */ } }
          throw error;
        } finally { saving = false; }
      },
      async close() {
        if (saving) throw new Error("Cannot close a state store while saving");
        await release();
      },
    };
    if (!resume) await store.save();
    return store;
  } catch (error) {
    try { await release(); } catch { /* Preserve the original open error. */ }
    throw error;
  }
}
