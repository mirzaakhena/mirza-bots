#!/usr/bin/env bun
/**
 * SessionStart hook: records which Claude Code session this bot's window is on.
 *
 * WHY IT EXISTS
 *
 * The MCP process cannot learn this by itself. It reads CLAUDE_CODE_SESSION_ID
 * once when spawned, and `/clear` starts a new session WITHOUT respawning it --
 * so the process keeps stamping an id that no longer refers to anything.
 * Measured 2026-08-02: Claude Code showed 2ef5b4c5-…, the engine was still
 * writing f850dfd0-…. This hook is a fresh process every time, so it is the one
 * thing that sees the change.
 *
 * WHY IT IMPORTS NOTHING BUT `node:`
 *
 * The first version imported the engine's config/paths/identity modules "to
 * avoid duplication", and never fired -- while the probe that preceded it, which
 * deliberately imported only node builtins, fired every time. The duplication it
 * avoided was a few lines; the price was a hook that looked installed and
 * guarded nothing, which is the most expensive shape a bug takes in this
 * project. A hook is not a good place to be clever about reuse.
 *
 * WHY IT LOGS BEFORE DOING ANYTHING ELSE
 *
 * So that "did not fire" and "fired and failed" stop looking identical from the
 * outside. The first line is written before any other work, and every later step
 * appends its own outcome. Diagnosing the previous version cost a full round of
 * guesswork precisely because it left nothing behind either way.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function stateRoot(): string {
  return process.env.MIRZA_BOTS_HOME ?? join(homedir(), ".claude", "mirza-bots");
}

function note(line: string): void {
  try {
    const dir = join(stateRoot(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "session-hook.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never be the thing that breaks the hook.
  }
}

export function parseHookInput(raw: string): any | null {
  try {
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

export function sessionIdFrom(input: any, env: NodeJS.ProcessEnv): string | undefined {
  const fromPayload = typeof input?.session_id === "string" ? input.session_id : "";
  if (fromPayload.length > 0) return fromPayload;
  const fromEnv = env.CLAUDE_CODE_SESSION_ID ?? "";
  return fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Which bot owns this directory, read straight from config.json.
 *
 * Plain JSON.parse rather than the engine's zod-validated loader: this hook needs
 * exactly one string out of that file, and pulling in the validator is what tied
 * the previous version to the engine's whole import graph. The engine still
 * validates the same file properly, in the place where a complaint reaches
 * someone who can act on it.
 */
/**
 * Same-directory test, spelled out here rather than imported from the engine.
 *
 * This hook imports nothing but `node:` on purpose (see the header), so it keeps
 * its own five-line copy instead of reaching into src/. The duplication is the
 * price of a hook that cannot be broken by anything upstream of it.
 *
 * Separators only, never case: Windows would call C:/BOT and C:/bot the same and
 * Linux would not, and answering "same" for two different directories is worse
 * than missing a match -- a missed match shows up in this hook's own log.
 */
function normalize(p: string): string {
  const withSlashes = p.split("\\").join("/");
  if (/^\/$/.test(withSlashes) || /^[A-Za-z]:\/$/.test(withSlashes)) return withSlashes;
  return withSlashes.endsWith("/") ? withSlashes.slice(0, -1) : withSlashes;
}

export function botForCwd(configRaw: string, cwd: string): string | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(configRaw.replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
  const bots = parsed?.bots;
  if (typeof bots !== "object" || bots === null) return undefined;
  for (const [name, bot] of Object.entries<any>(bots)) {
    if (typeof bot?.home === "string" && normalize(bot.home) === normalize(cwd)) return name;
  }
  return undefined;
}

function main(): void {
  note("fired");

  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    note("stdin unreadable (falling back to env)");
  }

  const payload = parseHookInput(raw) ?? {};
  const id = sessionIdFrom(payload, process.env);
  if (id === undefined) {
    note("no session id in payload or env -- leaving the previous value alone");
    return;
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  let configRaw = "";
  try {
    configRaw = readFileSync(join(stateRoot(), "config.json"), "utf8");
  } catch {
    note(`config.json unreadable; cwd=${cwd}`);
    return;
  }

  const bot = botForCwd(configRaw, cwd);
  if (bot === undefined) {
    // Not a bot folder. Nothing to record, and nothing to complain about either:
    // saying so here would mean shouting in every unrelated project the user
    // opens, which is how a useful signal turns into noise people filter out.
    note(`no bot has home=${cwd} -- nothing to record`);
    return;
  }

  try {
    const dir = join(stateRoot(), "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${bot}.id`), id);
    note(`wrote ${bot} = ${id} (source=${payload?.source ?? "-"})`);
  } catch (err) {
    // Worst case the engine keeps using the previous id -- exactly where it
    // would have been without this hook, never worse.
    note(`write failed for ${bot}: ${err}`);
  }
}

if (import.meta.main) main();
