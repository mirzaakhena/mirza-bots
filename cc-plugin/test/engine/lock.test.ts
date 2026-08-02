import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBotLock, releaseBotLock } from "../../src/engine/lock";

function tmpLock(): string {
  return join(mkdtempSync(join(tmpdir(), "lock-")), "bot-01.pid");
}

test("writes our pid when no holder exists", () => {
  const path = tmpLock();
  const res = acquireBotLock(path, 4242, { isAlive: () => false, terminate: () => {} });

  expect(res.previousPid).toBeNull();
  expect(readFileSync(path, "utf8")).toBe("4242");
});

test("takes over from a live holder and terminates it", () => {
  const path = tmpLock();
  writeFileSync(path, "1111");
  const killed: number[] = [];

  const res = acquireBotLock(path, 4242, {
    isAlive: (pid) => pid === 1111,
    terminate: (pid) => killed.push(pid),
  });

  expect(res.previousPid).toBe(1111);
  expect(killed).toEqual([1111]);
  expect(readFileSync(path, "utf8")).toBe("4242");
});

test("a stale pid is replaced without terminating anything", () => {
  const path = tmpLock();
  writeFileSync(path, "1111");
  const killed: number[] = [];

  const res = acquireBotLock(path, 4242, {
    isAlive: () => false,
    terminate: (pid) => killed.push(pid),
  });

  expect(res.previousPid).toBeNull();
  expect(killed).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("4242");
});

// Load bearing: without this guard a process that re-acquires its own lock would
// signal itself and take down the very poller it is trying to start.
test("never terminates our own pid", () => {
  const path = tmpLock();
  writeFileSync(path, "4242");
  const killed: number[] = [];

  const res = acquireBotLock(path, 4242, {
    isAlive: () => true,
    terminate: (pid) => killed.push(pid),
  });

  expect(res.previousPid).toBeNull();
  expect(killed).toEqual([]);
});

// A corrupt lock file must not stop the bot from starting. The guard exists to
// protect polling, not to gate it -- failing closed here would turn one unreadable
// byte into a permanently silent bot, which is the failure class this whole
// rewrite is about.
test("a garbage lock file is overwritten, not fatal", () => {
  const path = tmpLock();
  writeFileSync(path, "not-a-number");

  const res = acquireBotLock(path, 4242, { isAlive: () => true, terminate: () => {} });

  expect(res.previousPid).toBeNull();
  expect(readFileSync(path, "utf8")).toBe("4242");
});

test("creates the locks directory when it does not exist yet", () => {
  const path = join(mkdtempSync(join(tmpdir(), "lock-")), "locks", "bot-01.pid");

  acquireBotLock(path, 4242, { isAlive: () => false, terminate: () => {} });

  expect(readFileSync(path, "utf8")).toBe("4242");
});

test("release removes the file only when we still own it", () => {
  const path = tmpLock();
  writeFileSync(path, "9999");
  releaseBotLock(path, 4242);
  // Someone newer holds it; deleting their claim would leave the token unguarded.
  expect(existsSync(path)).toBe(true);

  writeFileSync(path, "4242");
  releaseBotLock(path, 4242);
  expect(existsSync(path)).toBe(false);
});
