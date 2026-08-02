import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationsDb } from "../../../src/engine/db/conversations-schema";
import { openFleetDb } from "../../../src/engine/db/fleet-schema";

// WAL lets readers and writers work in parallel, but two WRITERS still take
// turns. While one daemon owned both files that never mattered. Now up to six
// sessions open them, and without a busy timeout the loser of a write race gives
// up immediately with SQLITE_BUSY instead of waiting -- which surfaces as a
// random failure at the call site, very hard to trace back to concurrency.
test("conversations db waits instead of giving up when another writer holds the lock", () => {
  const db = openConversationsDb(join(mkdtempSync(join(tmpdir(), "db-")), "c.db"));
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  db.close();
});

test("fleet db waits too", () => {
  const db = openFleetDb(join(mkdtempSync(join(tmpdir(), "db-")), "f.db"));
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  db.close();
});
