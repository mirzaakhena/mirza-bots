import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { startEngine } from "../../src/engine/engine";
import {
  configPathIn,
  botPidPathIn,
  dataDirIn,
  inboxDirIn,
  logsDirIn,
} from "../../src/engine/paths";

/**
 * Sebuah folder bot: sebuah folder, dan config.json di dalamnya. Itu saja
 * syaratnya sekarang -- tidak ada state root, tidak ada pendaftaran.
 */
function botFolder(name: string, config?: unknown): string {
  const home = join(mkdtempSync(join(tmpdir(), "engine-")), name);
  mkdirSync(home, { recursive: true });
  if (config !== undefined) {
    // "utf8", never a BOM: PowerShell's Set-Content adds one by default and the
    // engine died on it three separate times (SCAR-026).
    writeFileSync(configPathIn(home), JSON.stringify(config), "utf8");
  }
  return home;
}

// W-16, stated as a test: startup failure must produce a sentence, not a
// vanished process. Every branch below returns rather than throws.
test("folder tanpa config.json ditolak dengan kalimat yang mengajari", () => {
  const res = startEngine(botFolder("bukan-bot"));

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message).toContain("config.json");
  expect(res.message).toContain("token");
});

test("a broken config produces a readable reason instead of a throw", () => {
  const home = botFolder("bot-rusak");
  writeFileSync(configPathIn(home), "{ this is not json", "utf8");

  const res = startEngine(home);

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message.toLowerCase()).toContain("config");
});

// Config lama membawa token bot LAIN. Menerimanya diam-diam akan membuat folder
// ini melayani token yang bukan miliknya, dan gejalanya baru muncul saat dua
// sesi berebut token yang sama (insiden 2026-08-04).
test("config bentuk lama (daftar bots) ditolak, bukan diabaikan", () => {
  const home = botFolder("bot-lama", {
    allowFrom: ["1"],
    bots: { "bot-01": { home: "C:\\elsewhere", token: "t" } },
  });

  const res = startEngine(home);

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message.toLowerCase()).toContain("config");
});

test("nama bot adalah nama folder, dan lock-nya bot.pid di dalam folder itu", () => {
  const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

  const res = startEngine(home);

  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.message);
  expect(res.engine.bot).toBe("bot-uji");

  const lock = botPidPathIn(home);
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));

  res.engine.close();
  // Released on close, so the next session does not have to displace a corpse.
  expect(existsSync(lock)).toBe(false);
});

test("folder bot menyiapkan data/, inbox/, dan logs/ miliknya sendiri", () => {
  const home = botFolder("bot-siap", { token: "123:fake", allowFrom: ["1"] });

  const res = startEngine(home);
  if (!res.ok) throw new Error(res.message);

  expect(existsSync(dataDirIn(home))).toBe(true);
  expect(existsSync(inboxDirIn(home))).toBe(true);
  expect(existsSync(logsDirIn(home))).toBe(true);

  res.engine.close();
});

// Pagar terhadap kembalinya state terpusat lewat pintu belakang. Membaca, tidak
// pernah menulis: ~/.claude/mirza-bots masih milik sistem produksi selama
// migrasi belum dijalankan.
test("tidak membuat apa pun di dalam ~/.claude/mirza-bots", () => {
  const stateRootLama = join(homedir(), ".claude", "mirza-bots");
  const sebelum = existsSync(stateRootLama);

  const home = botFolder("bot-bersih", { token: "123:fake", allowFrom: [] });
  const res = startEngine(home);
  if (!res.ok) throw new Error(res.message);
  res.engine.close();

  // Kalau foldernya memang sudah ada dari sistem lama, yang dibuktikan adalah
  // engine tidak MEMBUATNYA -- bukan bahwa ia tidak ada.
  expect(existsSync(stateRootLama)).toBe(sebelum);
});

// Polling starts before the MCP server finishes connecting. Dropping messages in
// that window would look exactly like the bot ignoring the first thing you said
// after opening a session.
test("messages arriving before onPush registers are held, then delivered in order", () => {
  const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

  const res = startEngine(home);
  if (!res.ok) throw new Error(res.message);

  const seen: string[] = [];
  res.engine.onPush((m) => seen.push(m.text));
  expect(seen).toEqual([]);

  res.engine.close();
});

test("reply before any message has arrived explains itself instead of guessing a chat", async () => {
  const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

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
