import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Guards the one rule Telegram will not bend: a single getUpdates consumer per
 * token. Two pollers on one token do not error loudly -- they split the user's
 * messages between them at random, which reads as "the bot sometimes listens".
 *
 * Scope is deliberately one bot, not the machine. Measured 2026-08-02: six bots
 * run six pollers against six different tokens and never contend. Only two
 * holders of the SAME token do.
 *
 * This is a cost created by dissolving the daemon, not a pre-existing one: while
 * a single daemon owned every token, "exactly one poller" was true by
 * construction and needed no mechanism at all.
 *
 * The mechanic is lifted from the old system
 * (mirza-marketplace/plugins/telegram/server.ts:99-120), where it has run in
 * production for months. What changed is only where the file lives: centralised
 * under the fleet's state root instead of scattered per bot folder.
 */
export type LockDeps = {
  isAlive: (pid: number) => boolean;
  terminate: (pid: number) => void;
};

export type AcquireResult = {
  /** The live holder we displaced, or null when there was nothing to displace. */
  previousPid: number | null;
};

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. Throws when the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultTerminate(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Gone between the liveness check and here -- exactly the outcome we wanted.
  }
}

export function acquireBotLock(
  path: string,
  pid: number,
  deps: Partial<LockDeps> = {}
): AcquireResult {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const terminate = deps.terminate ?? defaultTerminate;

  let previousPid: number | null = null;
  try {
    const held = parseInt(readFileSync(path, "utf8").trim(), 10);
    // `held !== pid` is load bearing: signalling ourselves would kill the poller
    // we are in the middle of starting.
    if (Number.isInteger(held) && held > 1 && held !== pid && isAlive(held)) {
      terminate(held);
      previousPid = held;
    }
  } catch {
    // Missing or unreadable file: nothing holds the token as far as we can tell.
    // Refusing to start over an unparseable guard would fail closed on the wrong
    // thing -- the guard exists to protect polling, not to gate it.
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
  return { previousPid };
}

/**
 * Drops the lock, but only if it is still ours: a newer process may already have
 * taken over, and deleting its claim would leave the token unguarded.
 */
export function releaseBotLock(path: string, pid: number): void {
  try {
    const held = parseInt(readFileSync(path, "utf8").trim(), 10);
    if (held === pid) unlinkSync(path);
  } catch {
    // Already gone, or never ours to remove.
  }
}
