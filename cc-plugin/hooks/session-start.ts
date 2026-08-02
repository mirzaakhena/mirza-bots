#!/usr/bin/env bun
/**
 * SessionStart hook: records which Claude Code session this bot's window is on.
 *
 * It exists because the MCP process cannot learn this by itself. It reads
 * CLAUDE_CODE_SESSION_ID once when it is spawned, and `/clear` starts a new
 * session WITHOUT respawning it -- so the process keeps stamping an id that no
 * longer refers to anything. This hook is a fresh process every time, so it is
 * the one thing that sees the moment of the change.
 *
 * Measured before this was written (probe, 2026-08-02):
 *
 *   03:34:34  session=05b5ed06…  source="startup"
 *   03:36:37  session=18e75c98…  source="clear"
 *
 * Both events are recorded the same way. `source` is not consulted: whichever
 * reason brought us here, the freshest id is the right one to store.
 *
 * Every failure path returns quietly. This hook only observes -- something that
 * merely observes must never be able to take down the thing it is observing.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { currentSessionPath, configPath } from "../src/engine/paths";
import { loadConfig } from "../src/engine/config";
import { resolveBotByCwd } from "../src/engine/identity";

/**
 * Parses the hook payload, tolerating a leading UTF-8 BOM.
 *
 * The BOM matters more than it looks: with one in front, JSON.parse throws,
 * main() returns early, and the hook does nothing at all -- while remaining
 * perfectly installed. Third BOM incident in this project (SCAR-026).
 */
export function parseHookInput(raw: string): any | null {
  try {
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/**
 * The session id to record, or undefined when there is nothing trustworthy.
 *
 * Payload first, env var second. Undefined means "leave the previous value
 * alone" rather than "blank it": "don't know" and "no session" are different
 * claims, and only one of them would be true.
 */
export function sessionIdFrom(input: any, env: NodeJS.ProcessEnv): string | undefined {
  const fromPayload = typeof input?.session_id === "string" ? input.session_id : "";
  if (fromPayload.length > 0) return fromPayload;
  const fromEnv = env.CLAUDE_CODE_SESSION_ID ?? "";
  return fromEnv.length > 0 ? fromEnv : undefined;
}

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // No stdin available; the env var may still answer.
  }

  const id = sessionIdFrom(parseHookInput(raw) ?? {}, process.env);
  if (id === undefined) return;

  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  let bot: string;
  try {
    const identity = resolveBotByCwd(loadConfig(configPath()), cwd);
    // Not a bot folder: nothing to record, and nothing to complain about either.
    // Telling the user here would mean shouting in every unrelated project they
    // open, which is how a useful signal becomes noise people learn to ignore.
    if (!identity.ok) return;
    bot = identity.bot;
  } catch {
    // An unreadable config is a real problem, but not this hook's to report:
    // the engine says so through its tools, in a place someone is listening.
    return;
  }

  try {
    const path = currentSessionPath(bot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id);
  } catch {
    // Worst case the engine keeps using the previous id, which is exactly where
    // it would have been without this hook -- never worse.
  }
}

if (import.meta.main) main();
