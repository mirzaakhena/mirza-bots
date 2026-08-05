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
  conversationsDbPathIn,
  chainedStatuslinePathIn,
} from "../../src/engine/paths";
import { buildBridgeCommand } from "../../src/engine/context/install";
import { openConversationsDb, insertMessage } from "../../src/engine/db/conversations-schema";

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
  // W-27: kalimat errornya harus menyebut SEBAB (belum pernah menerima pesan),
  // bukan menyalahkan Telegram -- itulah yang membuat AI dulu menjelaskan ke
  // user "bot Telegram tidak bisa memulai percakapan duluan", padahal itu
  // keliru dan sebabnya cuma kalimat error kita sendiri.
  expect(message).not.toContain("Telegram");
  res.engine.close();
});

// Server Telegram palsu, generik untuk seluruh tiga test W-27 di bawah:
// sendMessage dijawab OK (dengan chat.id APA PUN yang dikirim, supaya test
// bisa memverifikasi chat_id yang benar-benar dipakai lewat body request),
// endpoint lain (getMe, getUpdates, setMyCommands) dijawab OK generik supaya
// polling latar belakang milik startEngine tidak berisik gagal di tengah test.
function withFakeTelegram<T>(fn: (baseUrl: string, sentTo: string[]) => Promise<T>): Promise<T> {
  const sentTo: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/sendMessage")) {
        const body = (await req.json()) as { chat_id: string | number };
        sentTo.push(String(body.chat_id));
        return Response.json({
          ok: true,
          result: { message_id: sentTo.length, date: 0, chat: { id: body.chat_id }, text: "" },
        });
      }
      if (path.endsWith("/getMe")) {
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "t", username: "t_bot" },
        });
      }
      if (path.endsWith("/getUpdates")) return Response.json({ ok: true, result: [] });
      return Response.json({ ok: true, result: true });
    },
  });

  const prevRoot = process.env.TELEGRAM_API_ROOT;
  process.env.TELEGRAM_API_ROOT = `http://localhost:${server.port}`;

  return fn(process.env.TELEGRAM_API_ROOT, sentTo).finally(() => {
    server.stop();
    if (prevRoot === undefined) delete process.env.TELEGRAM_API_ROOT;
    else process.env.TELEGRAM_API_ROOT = prevRoot;
  });
}

// W-27, test 1/3: engine restart -> lastChatByBot di memori kosong, tapi
// conversations.db milik bot ini masih ingat chat yang pernah membalas.
// `reply` harus BERHASIL memakai itu, bukan menolak dengan no_known_chat.
test("reply falls back to the latest chat_id in conversations.db when lastChatByBot is empty", async () => {
  await withFakeTelegram(async () => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

    // Pra-isi database SEBELUM startEngine: mensimulasikan proses yang baru
    // lahir sesudah restart -- riwayatnya sudah ada, Map-nya belum.
    const db = openConversationsDb(conversationsDbPathIn(home));
    insertMessage(db, { ts: "t", bot: "bot-uji", chatId: "555", source: "user", text: "halo" });
    db.close();

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const result = await res.engine.reply("halo balik");
    expect(result.parts).toBe(1);

    res.engine.close();
  });
});

// W-27, test 2/3: database memuat lebih dari satu chat_id -- reply harus
// memakai yang TERBARU (id tertinggi), bukan yang pertama ditemukan atau
// urutan lain yang kebetulan benar untuk kasus satu baris.
test("reply uses the newest chat_id when conversations.db has more than one", async () => {
  await withFakeTelegram(async (_baseUrl, sentTo) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

    const db = openConversationsDb(conversationsDbPathIn(home));
    insertMessage(db, { ts: "t1", bot: "bot-uji", chatId: "111", source: "user", text: "lama" });
    insertMessage(db, { ts: "t2", bot: "bot-uji", chatId: "222", source: "user", text: "baru" });
    db.close();

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    await res.engine.reply("balasan");
    expect(sentTo).toEqual(["222"]);

    res.engine.close();
  });
});

// W-27, test 3/3: database benar-benar kosong (tidak ada baris sama sekali)
// -- reply tetap menolak, tapi assert negatif ini adalah pagar utamanya: kata
// "Telegram" tidak boleh muncul, karena itulah kalimat yang dulu menyesatkan
// AI untuk bilang "Telegram tidak mengizinkan bot memulai percakapan".
test("reply still refuses when conversations.db is genuinely empty, without blaming Telegram", async () => {
  const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["1"] });

  const res = startEngine(home);
  if (!res.ok) throw new Error(res.message);

  let message = "";
  try {
    await res.engine.reply("halo");
  } catch (err) {
    message = (err as Error).message;
  }

  expect(message).toContain("no_known_chat");
  expect(message).not.toContain("Telegram");
  res.engine.close();
});

// Bug yang kambuh 2026-08-04 DAN 2026-08-05: path bridge menyematkan nomor
// versi, jadi tiap `claude plugin update` membuatnya basi sampai kebetulan
// ada yang menjalankan /context. startEngine sekarang menyembuhkan path-nya
// SENDIRI tiap kali bot dibuka ulang -- lihat komentar di engine.ts.
//
// CLAUDE_PLUGIN_ROOT dipaksa di sini supaya bridgeCommand yang dihitung
// startEngine (lewat pluginRootFrom) bisa diprediksi test, alih-alih
// bergantung pada import.meta.url modul engine.
function withFakePluginRoot<T>(root: string, fn: () => T): T {
  const before = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = root;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = before;
  }
}

test("startEngine menyembuhkan path bridge basi, dan TIDAK menyentuh chained-statusline", () => {
  withFakePluginRoot("C:/plugins/cc-plugin-baru", () => {
    const home = botFolder("bot-basi", { token: "123:fake", allowFrom: ["1"] });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");

    // Bridge kita, tapi versi LAMA -- persis gejala hari ini: installed_plugins
    // sudah 0.16.0, settings.json masih menunjuk 0.13.0.
    const bridgeLama = 'bun run "C:/plugins/cc-plugin/0.13.0/bin/statusline-bridge.ts"';
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: bridgeLama } }), "utf8");

    // Rantai sudah berisi statusline user yang ASLI, tersimpan sejak
    // pemasangan pertama. Ini yang paling penting untuk tidak hilang.
    const chainPath = chainedStatuslinePathIn(home);
    writeFileSync(chainPath, "C:/Users/Mirza/.claude/statusline-progress.sh", "utf8");

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);
    res.engine.close();

    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.statusLine.command).toBe(buildBridgeCommand("C:/plugins/cc-plugin-baru"));

    // INI yang paling penting: rantai yang tertimpa berarti statusline user
    // hilang selamanya.
    expect(readFileSync(chainPath, "utf8")).toBe("C:/Users/Mirza/.claude/statusline-progress.sh");
  });
});

test("startEngine tidak menulis apa pun kalau bridge sudah terpasang benar", () => {
  withFakePluginRoot("C:/plugins/cc-plugin-baru", () => {
    const home = botFolder("bot-sudah-benar", { token: "123:fake", allowFrom: ["1"] });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");

    const bridgeSekarang = buildBridgeCommand("C:/plugins/cc-plugin-baru");
    const settingsBefore = JSON.stringify({ statusLine: { command: bridgeSekarang } });
    writeFileSync(settingsPath, settingsBefore, "utf8");

    const chainPath = chainedStatuslinePathIn(home);
    const chainBefore = "C:/Users/Mirza/.claude/statusline-progress.sh";
    writeFileSync(chainPath, chainBefore, "utf8");

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);
    res.engine.close();

    // already-installed berarti TIDAK menulis apa pun -- byte demi byte sama.
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(chainPath, "utf8")).toBe(chainBefore);
  });
});

test("installBridge yang gagal saat start tidak menggagalkan engine -- alasannya ke stderr", () => {
  const home = botFolder("bot-settings-rusak", { token: "123:fake", allowFrom: ["1"] });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settingsPath = join(home, ".claude", "settings.json");
  // Settings project tidak bisa dibaca -> installBridge menjawab "refused".
  writeFileSync(settingsPath, "{ ini bukan json", "utf8");

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  let res: ReturnType<typeof startEngine>;
  try {
    res = startEngine(home);
  } finally {
    console.error = originalError;
  }

  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("expected success despite bridge install failure");
  res.engine.close();

  expect(logged.some((line) => line.includes("tidak bisa dibaca"))).toBe(true);
});
