import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine, nextPushOrigin, buildAgentOriginMarker } from "../../src/engine/engine";
import type { Engine } from "../../src/engine/engine";
import {
  configPathIn,
  inboxDirIn,
  conversationsDbPathIn,
  sessionIdPathIn,
  statusPathIn,
} from "../../src/engine/paths";
import {
  openConversationsDb,
  getNotifiedSessionName,
} from "../../src/engine/db/conversations-schema";
import { writeCapturedStatus } from "../../src/engine/context/status-file";
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

/** Satu baris `custom-title` persis seperti yang Claude Code tulis. */
function titleLine(sessionId: string, title: string): string {
  return JSON.stringify({ type: "custom-title", sessionId, customTitle: title });
}

/** Menunggu sebuah KEADAAN, bukan durasi tebakan. */
async function waitUntil<T>(probe: () => T | undefined | null, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = probe();
    if (hit !== undefined && hit !== null) return hit;
    if (Date.now() > deadline) throw new Error("timeout menunggu keadaan");
    await new Promise((r) => setTimeout(r, 100));
  }
}

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

// Pengumuman mesin BUKAN balasan untuk siapa pun -- ia lahir dari timer 5
// detik, bukan dari sebuah giliran. Penanda menjawab "giliran ini dipicu
// siapa", jadi menempelkannya di sini berarti menjawab pertanyaan yang tidak
// pernah diajukan, dan jawabannya SELALU salah apa pun isinya.
//
// Terukur produksi pada `mirza_02_bot`: baris 78 (2026-08-07 08:36 WIB) dan
// baris 111 (2026-08-08 09:06 WIB) di conversations.db, dua-duanya
// "✏️ Sesi sekarang: ..." yang diawali "Dipicu oleh bot lain (bot-03)" --
// padahal yang menekan /branch adalah user, dan bot-03 terakhir bicara
// entah berapa lama sebelumnya. Slash Telegram diproses dengan
// `pushToAi: false` sehingga tidak pernah melewati `sink.push`, jadi origin
// lama bertahan melewati /clear sekalipun (proses engine tidak restart).
test("pengumuman ganti nama sesi tidak pernah membawa penanda antar-bot", async () => {
  await withFakeTelegram(async ({ enqueue, sent }) => {
    const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["555"] });

    // Transcript CC palsu: di sinilah nama sesi sungguhan dibaca (bukan dari
    // status.json -- lihat context/session-title.ts).
    const sessionId = "11111111-2222-3333-4444-555555555555";
    writeFileSync(sessionIdPathIn(home), sessionId, "utf8");
    const ccDir = mkdtempSync(join(tmpdir(), "cc-transcript-"));
    const transcript = join(ccDir, `${sessionId}.jsonl`);
    writeFileSync(transcript, `${titleLine(sessionId, "nama-awal")}\n`, "utf8");
    writeCapturedStatus(statusPathIn(home), { transcript_path: transcript }, Date.now());

    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user"));
    await pushes.wait((m) => m.text === "halo dari user");

    dropAgentMessage(home, "u-1.json", "bot-03", "titipan lama dari bot-03");
    await pushes.wait((m) => m.meta.origin === AGENT_ORIGIN && m.meta.from_bot === "bot-03");

    // Bukti antara: origin memang agent pada titik ini, jadi test ini
    // benar-benar menguji pengecualian pengumuman -- bukan kebetulan bersih.
    await res.engine.reply("balasan yang MEMANG dipicu bot-03");
    expect(lastAssistantText(home).startsWith(MARKER_PREFIX)).toBe(true);

    // Pengumuman start harus lebih dulu mencatat nama awal, kalau tidak
    // shouldNotifyRename menolak mengumumkan apa pun (lastNotified null).
    await waitUntil(() => {
      const db = openConversationsDb(conversationsDbPathIn(home));
      const name = getNotifiedSessionName(db);
      db.close();
      return name;
    });

    // Nama sesi berubah -- persis yang dilakukan /branch, /clear, /rename.
    writeFileSync(
      transcript,
      `${titleLine(sessionId, "nama-awal")}\n${titleLine(sessionId, "nama-baru")}\n`,
      "utf8"
    );

    const notice = await waitUntil(() => sent.find((s) => s.text.includes("nama-baru")));
    expect(notice.text).not.toContain(MARKER_PREFIX);

    res.engine.close();
  });
}, 30000);

/** Satu entri transcript yang Claude Code tulis saat monitor periodik memicu giliran. */
function taskNotificationLine(): string {
  return JSON.stringify({
    type: "user",
    origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>\n<summary>Monitor event</summary>\n" },
  });
}

/** Satu entri transcript untuk push antar-bot sungguhan. */
function agentPushLine(fromBot: string): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    origin: { kind: "channel", server: "plugin:cc-plugin:cc-plugin" },
    message: {
      role: "user",
      content:
        `<channel source="plugin:cc-plugin:cc-plugin" origin="agent" from_bot="${fromBot}" ` +
        `agent_message_id="x" hop_count="0">\n[from: agent]\nkerjakan ini`,
    },
  });
}

/** Folder bot + transcript CC palsu yang isinya diatur test. */
function botWithTranscript(lines: string[]): { home: string; transcript: string } {
  const home = botFolder("bot-uji", { token: "123:fake", allowFrom: ["555"] });
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeFileSync(sessionIdPathIn(home), sessionId, "utf8");
  const ccDir = mkdtempSync(join(tmpdir(), "cc-transcript-"));
  const transcript = join(ccDir, `${sessionId}.jsonl`);
  writeFileSync(transcript, `${lines.join("\n")}\n`, "utf8");
  writeCapturedStatus(statusPathIn(home), { transcript_path: transcript }, Date.now());
  return { home, transcript };
}

// REGRESI PRODUKSI, dan alasan seluruh perubahan ini ada.
//
// Terukur `bot-02` 2026-08-13: push dari bot-04 masuk pukul 04:16, lalu SELAMA
// 1,5 JAM setiap laporan monitor sweep milik bot itu sendiri (conversations.db
// #178..#183) terbit dengan penanda "Dipicu oleh bot lain (bot-04)". User
// akhirnya bertanya sendiri (#184), dan sudah mengonfirmasi ke bot-04 bahwa dia
// tidak memicu apa pun (#187).
//
// Monitor periodik tidak pernah lewat `sink.push`, jadi `lastPushOrigin` masih
// mengingat bot-04 -- ingatan proses tidak tahu batas giliran. Transcript tahu:
// pemicu giliran itu `origin.kind === "task-notification"`.
test("regresi: monitor periodik sesudah push antar-bot -> nol penanda", async () => {
  await withFakeTelegram(async ({ enqueue }) => {
    const { home } = botWithTranscript([taskNotificationLine()]);
    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user"));
    await pushes.wait((m) => m.text === "halo dari user");

    // Push antar-bot SUNGGUHAN masuk -- ingatan proses sekarang menyebut bot-04.
    dropAgentMessage(home, "u-1.json", "bot-04", "titipan kerjaan");
    await pushes.wait((m) => m.meta.origin === AGENT_ORIGIN && m.meta.from_bot === "bot-04");

    // ...tapi giliran yang menerbitkan laporan ini dipicu monitornya sendiri.
    await res.engine.reply("django__django-13321 → FAIL (wrong_patch)");

    const stored = lastAssistantText(home);
    expect(stored).not.toContain(MARKER_PREFIX);
    expect(stored).not.toContain("bot-04");

    res.engine.close();
  });
});

// Sisi sebaliknya, dan yang menjaga perbaikan di atas tidak berubah menjadi
// "penanda dimatikan": giliran yang transcriptnya MEMANG dipicu push antar-bot
// tetap wajib ditandai -- bahkan ketika ingatan proses berkata "user", yang
// membuktikan transcript benar-benar sudah menjadi sumbernya.
test("transcript berpemicu antar-bot -> tetap ditandai walau push terakhir dari user", async () => {
  await withFakeTelegram(async ({ enqueue }) => {
    const { home } = botWithTranscript([agentPushLine("bot-03")]);
    const res = startEngine(home);
    if (!res.ok) throw new Error(res.message);

    const pushes = collectPushes(res.engine);
    enqueue(textUpdate(555, "halo dari user"));
    await pushes.wait((m) => m.text === "halo dari user");

    await res.engine.reply("balasan untuk titipan bot-03");

    const stored = lastAssistantText(home);
    expect(stored.startsWith(MARKER_PREFIX)).toBe(true);
    expect(stored).toContain("bot-03");

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
