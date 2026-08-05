import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, nextPushOrigin, buildAgentOriginMarker } from "../../src/engine/engine";
import type { Engine } from "../../src/engine/engine";
import { configPathIn, inboxDirIn, conversationsDbPathIn } from "../../src/engine/paths";
import { openConversationsDb } from "../../src/engine/db/conversations-schema";
import { AGENT_ORIGIN } from "../../src/engine/agent/receive";
import type { PushMessage } from "../../src/engine/sink";

/**
 * AB-4 opsi B: `reply` yang lahir dari giliran yang dipicu pesan antar-bot
 * WAJIB menempelkan penanda -- ditegakkan di engine, bukan kesopanan AI.
 *
 * Test di file ini dibagi dua kelompok:
 *  - fungsi murni (nextPushOrigin / buildAgentOriginMarker), diuji langsung
 *    tanpa engine sama sekali;
 *  - integrasi lewat startEngine sungguhan, karena state "push terakhir"
 *    hidup di dalam closure yang dibuat startEngine dan TIDAK bisa disuntik
 *    dari luar -- satu-satunya cara membuktikan perilakunya benar adalah
 *    mendorong pesan lewat jalur produksi yang sebenarnya (poller Telegram
 *    untuk user, drainInbox untuk bot lain).
 */

function botFolder(name: string, config: unknown): string {
  const home = join(mkdtempSync(join(tmpdir(), "marker-")), name);
  mkdirSync(home, { recursive: true });
  writeFileSync(configPathIn(home), JSON.stringify(config), "utf8");
  return home;
}

/**
 * Server Telegram palsu yang bisa disuntik update KAPAN SAJA lewat
 * `enqueue`, bukan hanya sekali di awal -- test reset butuh menyuntikkan
 * pesan user SESUDAH pesan antar-bot sudah diproses, bukan bersamaan.
 */
function withFakeTelegram<T>(
  fn: (ctx: {
    enqueue: (update: unknown) => void;
    sent: { chatId: string; text: string }[];
  }) => Promise<T>
): Promise<T> {
  const queue: unknown[] = [];
  const sent: { chatId: string; text: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/sendMessage")) {
        const body = (await req.json()) as { chat_id: string | number; text: string };
        sent.push({ chatId: String(body.chat_id), text: body.text });
        return Response.json({
          ok: true,
          result: { message_id: sent.length, date: 0, chat: { id: body.chat_id }, text: body.text },
        });
      }
      if (path.endsWith("/getMe")) {
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "t", username: "t_bot" },
        });
      }
      if (path.endsWith("/getUpdates")) {
        if (queue.length > 0) {
          const batch = queue.splice(0, queue.length);
          return Response.json({ ok: true, result: batch });
        }
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: true });
    },
  });

  const prevRoot = process.env.TELEGRAM_API_ROOT;
  process.env.TELEGRAM_API_ROOT = `http://localhost:${server.port}`;

  return fn({ enqueue: (u) => queue.push(u), sent }).finally(() => {
    server.stop();
    if (prevRoot === undefined) delete process.env.TELEGRAM_API_ROOT;
    else process.env.TELEGRAM_API_ROOT = prevRoot;
  });
}

let nextUpdateId = 1;
let nextMessageId = 100;

/** Update Telegram nyata untuk satu pesan teks -- lewat poller SUNGGUHAN. */
function textUpdate(chatId: number, text: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "U" },
      text,
    },
  };
}

/** Menitipkan pesan antar-bot lewat inbox -- lewat drainInbox SUNGGUHAN. */
function dropAgentMessage(home: string, filename: string, from: string, text: string): void {
  writeFileSync(
    join(inboxDirIn(home), filename),
    JSON.stringify({
      id: filename,
      ts: new Date().toISOString(),
      from,
      text,
      expects_reply: false,
      hop_count: 1,
    })
  );
}

/**
 * Menunggu push TERTENTU sampai, bukan menebak lewat sleep tetap. `sink.push`
 * (di dalam startEngine) memperbarui origin SEBELUM meneruskan ke handler ini,
 * jadi begitu predicate cocok, state yang mau diuji sudah benar.
 */
function collectPushes(engine: Engine) {
  const seen: PushMessage[] = [];
  const waiters: Array<{ matches: (m: PushMessage) => boolean; resolve: (m: PushMessage) => void }> =
    [];
  engine.onPush((m) => {
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.matches(m)) {
        waiters[i]!.resolve(m);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    wait(matches: (m: PushMessage) => boolean, timeoutMs = 5000): Promise<PushMessage> {
      const already = seen.find(matches);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout menunggu push")), timeoutMs);
        waiters.push({
          matches,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

/** Baris terakhir yang engine kirim sebagai balasan (source=assistant). */
function lastAssistantText(home: string): string {
  const db = openConversationsDb(conversationsDbPathIn(home));
  const row = db
    .query("SELECT text FROM messages WHERE source = 'assistant' ORDER BY id DESC LIMIT 1")
    .get() as { text: string } | null;
  db.close();
  if (!row) throw new Error("tidak ada baris assistant tersimpan");
  return row.text;
}

const MARKER_PREFIX = "🤖 Dipicu oleh bot lain";

// ---------------------------------------------------------------------------
// Fungsi murni
// ---------------------------------------------------------------------------

test("nextPushOrigin: meta tanpa origin (pesan Telegram biasa) -> user", () => {
  expect(nextPushOrigin({ chat_id: "1", user_id: "1", ts: "t", kind: "message" })).toEqual({
    kind: "user",
  });
});

test("nextPushOrigin: meta.origin agent -> agent dengan nama pengirimnya", () => {
  expect(
    nextPushOrigin({ origin: AGENT_ORIGIN, from_bot: "mirza_01_bot", agent_message_id: "u-1" })
  ).toEqual({ kind: "agent", fromBot: "mirza_01_bot" });
});

test("buildAgentOriginMarker: null untuk origin user -- reply biasa tidak boleh berisik", () => {
  expect(buildAgentOriginMarker({ kind: "user" })).toBeNull();
});

test("buildAgentOriginMarker: menyebut nama bot pemicunya, bahasa Indonesia", () => {
  const marker = buildAgentOriginMarker({ kind: "agent", fromBot: "mirza_01_bot" });
  expect(marker).not.toBeNull();
  expect(marker).toContain("mirza_01_bot");
  expect(marker).toContain(MARKER_PREFIX);
});

// ---------------------------------------------------------------------------
// Integrasi: startEngine sungguhan
// ---------------------------------------------------------------------------

// Kasus mayoritas mutlak: reply yang dipicu pesan USER tidak boleh kena
// penanda apa pun. Kalau ini berisik, perubahan AB-4 merugikan, bukan menolong.
test("reply sesudah push user -> teks apa adanya, nol penanda", async () => {
  await withFakeTelegram(async ({ enqueue }) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["555"] });
    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user"));
    await pushes.wait((m) => m.text === "halo dari user");

    const result = await res.engine.reply("balasan biasa");
    expect(result.parts).toBe(1);

    const stored = lastAssistantText(home);
    expect(stored).toBe("balasan biasa");
    expect(stored).not.toContain(MARKER_PREFIX);

    res.engine.close();
  });
});

// Inti fitur: reply yang dipicu pesan ANTAR-BOT wajib diawali penanda, dan
// penanda itu memuat nama bot yang memicunya.
test("reply sesudah push antar-bot -> teks diawali penanda bernama bot pemicunya", async () => {
  await withFakeTelegram(async ({ enqueue }) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["555"] });
    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    // Chat harus dikenal supaya reply tidak menolak dengan no_known_chat --
    // dipenuhi lewat SATU pesan user dulu, sebelum pesan antar-bot yang
    // sesungguhnya diuji di sini.
    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user"));
    await pushes.wait((m) => m.text === "halo dari user");

    dropAgentMessage(home, "u-1.json", "mirza_01_bot", "tolong sapa dia di Telegram");
    await pushes.wait((m) => m.meta.origin === AGENT_ORIGIN && m.meta.from_bot === "mirza_01_bot");

    const result = await res.engine.reply("halo, ada titipan dari bot lain");
    expect(result.parts).toBe(1);

    const stored = lastAssistantText(home);
    expect(stored.startsWith(MARKER_PREFIX)).toBe(true);
    expect(stored).toContain("mirza_01_bot");
    expect(stored).toContain("halo, ada titipan dari bot lain");

    res.engine.close();
  });
});

// Membuktikan ia mengambil yang TERAKHIR, bukan yang pertama atau yang mana
// saja: dua bot berbeda mengirim berturut-turut, penandanya harus menyebut
// bot KEDUA sahaja.
test("penanda memakai nama bot TERAKHIR ketika dua bot berbeda mengirim berturut-turut", async () => {
  await withFakeTelegram(async ({ enqueue }) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["555"] });
    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user"));
    await pushes.wait((m) => m.text === "halo dari user");

    dropAgentMessage(home, "u-1.json", "mirza_01_bot", "pesan pertama");
    await pushes.wait((m) => m.meta.origin === AGENT_ORIGIN && m.meta.from_bot === "mirza_01_bot");

    dropAgentMessage(home, "u-2.json", "bot-02", "pesan kedua");
    await pushes.wait((m) => m.meta.origin === AGENT_ORIGIN && m.meta.from_bot === "bot-02");

    await res.engine.reply("balasan sesudah dua bot");

    const stored = lastAssistantText(home);
    expect(stored).toContain("bot-02");
    expect(stored).not.toContain("mirza_01_bot");

    res.engine.close();
  });
});

// Reset -- inilah yang mengunci "tidak nyangkut" (bukan flag ala
// `telegramDriven` lama, audit area-10 §10.2). Tanpa test ini bug sistem
// lama bisa lahir kembali diam-diam.
test("reset: push antar-bot lalu push user, lalu reply -> nol penanda", async () => {
  await withFakeTelegram(async ({ enqueue }) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["555"] });
    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user pertama"));
    await pushes.wait((m) => m.text === "halo dari user pertama");

    dropAgentMessage(home, "u-1.json", "mirza_01_bot", "tolong sapa dia di Telegram");
    await pushes.wait((m) => m.meta.origin === AGENT_ORIGIN && m.meta.from_bot === "mirza_01_bot");

    // Bukti antara: pada titik ini origin SUNGGUH agent -- membuktikan test
    // ini benar-benar menguji sebuah TRANSISI, bukan cuma keadaan default.
    await res.engine.reply("balasan sebelum reset");
    expect(lastAssistantText(home).startsWith(MARKER_PREFIX)).toBe(true);

    // Push USER berikutnya HARUS mengembalikan origin ke "user" -- inilah
    // yang gagal di sistem lama (`telegramDriven`), yang sekali menyala tidak
    // pernah padam.
    enqueue(textUpdate(555, "halo dari user kedua"));
    await pushes.wait((m) => m.text === "halo dari user kedua");

    await res.engine.reply("balasan sesudah reset");
    const stored = lastAssistantText(home);
    expect(stored).toBe("balasan sesudah reset");
    expect(stored).not.toContain(MARKER_PREFIX);

    res.engine.close();
  });
});
