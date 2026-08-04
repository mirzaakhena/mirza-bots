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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function note(botHome: string, line: string): void {
  try {
    const dir = join(botHome, "logs");
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
 * Sebuah folder adalah bot bila ia memuat config.json.
 *
 * Menggantikan `botForCwd`, yang membaca daftar `bots` dan mencocokkan `home`
 * tiap entri ke cwd. Pencocokan itu punya sekelas bug sendiri -- separator,
 * trailing slash, kapitalisasi -- dan salah satunya benar-benar terjadi
 * (2026-08-02: CC memberi forward slash, config menyimpan backslash, dan bot
 * tidak mengenali rumahnya sendiri). Keberadaan sebuah berkas tidak bisa salah
 * cocok.
 *
 * Aturan yang sama dipakai engine dan pemindai tetangga. Dieja ulang di sini,
 * bukan diimpor, karena hook ini hanya boleh mengimpor `node:` (lihat header).
 */
export function isBotFolder(cwd: string): boolean {
  return existsSync(join(cwd, "config.json"));
}

/** Nama bot = nama folder. Salinan sengaja dari paths.botNameFrom, alasan sama. */
export function botNameOf(cwd: string): string {
  const n = cwd.split("\\").join("/").replace(/\/+$/, "");
  return n.slice(n.lastIndexOf("/") + 1);
}

function main(): void {
  // cwd dihitung PERTAMA, karena sekarang ia juga menentukan ke mana log
  // ditulis. Tanpa itu tidak ada tempat untuk mencatat "fired".
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  note(cwd, "fired");

  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    note(cwd, "stdin unreadable (falling back to env)");
  }

  const payload = parseHookInput(raw) ?? {};
  const id = sessionIdFrom(payload, process.env);
  if (id === undefined) {
    note(cwd, "no session id in payload or env -- leaving the previous value alone");
    return;
  }

  if (!isBotFolder(cwd)) {
    // Not a bot folder. Nothing to record, and nothing to complain about either:
    // saying so here would mean shouting in every unrelated project the user
    // opens, which is how a useful signal turns into noise people filter out.
    note(cwd, `no config.json in ${cwd} -- nothing to record`);
    return;
  }

  try {
    writeFileSync(join(cwd, "session.id"), id);
    note(cwd, `wrote ${botNameOf(cwd)} = ${id} (source=${payload?.source ?? "-"})`);
  } catch (err) {
    // Worst case the engine keeps using the previous id -- exactly where it
    // would have been without this hook, never worse.
    note(cwd, `write failed for ${botNameOf(cwd)}: ${err}`);
  }
}

if (import.meta.main) main();
