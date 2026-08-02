import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine } from "../../src/engine/engine";

afterEach(() => {
  delete process.env.MIRZA_BOTS_HOME;
});

function fleetHome(bots: Record<string, { home: string; token: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "engine-"));
  mkdirSync(join(root, "inbox"), { recursive: true });
  // "utf8", never a BOM: PowerShell's Set-Content adds one by default and fleetd
  // died on it three separate times (SCAR-026).
  writeFileSync(join(root, "config.json"), JSON.stringify({ allowFrom: ["1"], bots }), "utf8");
  return root;
}

// W-16, stated as a test: startup failure must produce a sentence, not a
// vanished process. Every branch below returns rather than throws.
test("refuses to start for a cwd that is no bot's home, and names the registered bots", () => {
  const root = fleetHome({ "bot-01": { home: "C:\\elsewhere", token: "t" } });
  process.env.MIRZA_BOTS_HOME = root;

  const res = startEngine("C:\\not-a-bot");

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message).toContain("bot-01");
  expect(res.message).toContain("config.json");
});

test("a broken config produces a readable reason instead of a throw", () => {
  const root = mkdtempSync(join(tmpdir(), "engine-"));
  writeFileSync(join(root, "config.json"), "{ this is not json", "utf8");
  process.env.MIRZA_BOTS_HOME = root;

  const res = startEngine("C:\\anything");

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message.toLowerCase()).toContain("config");
});

test("a missing config produces a readable reason too", () => {
  process.env.MIRZA_BOTS_HOME = join(mkdtempSync(join(tmpdir(), "engine-")), "nothing-here");

  const res = startEngine("C:\\anything");

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message.toLowerCase()).toContain("config");
});

test("a resolved bot claims the token lock under the fleet state root", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-home-"));
  const root = fleetHome({ "bot-uji": { home, token: "123:fake" } });
  process.env.MIRZA_BOTS_HOME = root;

  const res = startEngine(home, "sess-1");

  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.message);
  expect(res.engine.bot).toBe("bot-uji");

  const lock = join(root, "locks", "bot-uji.pid");
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));

  res.engine.close();
  // Released on close, so the next session does not have to displace a corpse.
  expect(existsSync(lock)).toBe(false);
});

// Polling starts before the MCP server finishes connecting. Dropping messages in
// that window would look exactly like the bot ignoring the first thing you said
// after opening a session.
test("messages arriving before onPush registers are held, then delivered in order", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-home-"));
  process.env.MIRZA_BOTS_HOME = fleetHome({ "bot-uji": { home, token: "123:fake" } });

  const res = startEngine(home);
  if (!res.ok) throw new Error(res.message);

  const seen: string[] = [];
  res.engine.onPush((m) => seen.push(m.text));
  expect(seen).toEqual([]);

  res.engine.close();
});

test("reply before any message has arrived explains itself instead of guessing a chat", async () => {
  const home = mkdtempSync(join(tmpdir(), "bot-home-"));
  process.env.MIRZA_BOTS_HOME = fleetHome({ "bot-uji": { home, token: "123:fake" } });

  const res = startEngine(home);
  if (!res.ok) throw new Error(res.message);

  // try/catch, not expect().rejects: on Windows that matcher hangs forever when
  // the promise settles off an event loop turn (W-6).
  let message = "";
  try {
    await res.engine.reply("halo");
  } catch (err) {
    message = (err as Error).message;
  }

  expect(message).toContain("no_known_chat");
  res.engine.close();
});
