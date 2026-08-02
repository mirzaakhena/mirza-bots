import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export function stateRoot(): string {
  return process.env.MIRZA_BOTS_HOME ?? join(homedir(), ".claude", "mirza-bots");
}

export function configPath(): string {
  return join(stateRoot(), "config.json");
}

export function fleetDbPath(): string {
  return join(stateRoot(), "fleet.db");
}

export function conversationsDbPath(): string {
  return join(stateRoot(), "conversations.db");
}

export function inboxDir(bot: string): string {
  return join(stateRoot(), "inbox", bot);
}

export function logsDir(): string {
  return join(stateRoot(), "logs");
}

// Centralised on purpose. The old system kept each bot's pid file inside that
// bot's own folder, which is the scattered-state pattern this rewrite exists to
// undo: with them gathered here, "who currently holds which token" is one
// directory listing rather than six.
export function locksDir(): string {
  return join(stateRoot(), "locks");
}

export function lockPath(bot: string): string {
  return join(locksDir(), `${bot}.pid`);
}

// Written by the SessionStart hook, read by the engine on every push. Separate
// from the lock on purpose: the lock answers "which PROCESS owns this token",
// this answers "which SESSION that process's window is on" -- and the second
// changes without the first moving at all.
export function sessionsDir(): string {
  return join(stateRoot(), "sessions");
}

export function currentSessionPath(bot: string): string {
  return join(sessionsDir(), `${bot}.id`);
}

export function ensureStateDirs(): void {
  const root = stateRoot();
  for (const dir of [root, join(root, "inbox"), logsDir(), locksDir(), sessionsDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
