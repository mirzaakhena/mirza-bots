import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  buildServer,
  USER_TURN_MARKER,
  AGENT_TURN_MARKER,
  SYSTEM_TURN_MARKER,
  markerFor,
  INSTRUCTION_BLOCKS,
  RULE_IDS,
  renderInstructions,
} from "../src/server";
import { slashDirIn } from "../src/engine/paths";
import type { Engine } from "../src/engine/engine";
import type { PushMessage } from "../src/engine/sink";

// Folder bot untuk test. Sengaja nyata (tmpdir), bukan string karangan: tool
// send_slash MENULIS ke sini, dan folder karangan akan lolos di test lalu gagal
// di produksi.
const testHome = () => mkdtempSync(joinPath(tmpdir(), "srv-home-"));

function fakeEngine(overrides: Partial<Engine> = {}): Engine {
  return {
    bot: "bot-01",
    reply: async () => ({ chars: 0, parts: 1, files: 0 }),
    agentSend: () => ({ ok: true as const, id: "u", path: "p" }),
    agentPeers: () => [],
    history: async () => [],
    search: async () => [],
    onPush: () => {},
    close: () => {},
    ...overrides,
  } as unknown as Engine;
}

describe("cc-plugin MCP server", () => {
  test("the reply tool proxies its text argument to Engine.reply", async () => {
    const replied: string[] = [];
    const client = fakeEngine({
      reply: async (text: string) => {
        replied.push(text);
        return { chars: text.length, parts: 1, files: 0 };
      },
    });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result = await mcpClient.callTool({ name: "reply", arguments: { text: "halo dari AI" } });

    expect(replied).toEqual(["halo dari AI"]);
    expect(result.isError).toBeFalsy();

    await mcpClient.close();
    await server.close();
  });

  test("the reply tool passes an optional buttons argument through to Engine.reply", async () => {
    const calls: Array<{ text: string; buttons?: unknown }> = [];
    const client = fakeEngine({
      reply: async (text: string, buttons?: any) => {
        calls.push({ text, buttons });
        return { chars: text.length, parts: 1, files: 0 };
      },
    });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    await mcpClient.callTool({
      name: "reply",
      arguments: {
        text: "Pilih salah satu:",
        buttons: [[{ text: "Ya", data: "confirm_yes" }, { text: "Tidak", data: "confirm_no" }]],
      },
    });

    expect(calls).toEqual([
      {
        text: "Pilih salah satu:",
        buttons: [[{ text: "Ya", data: "confirm_yes" }, { text: "Tidak", data: "confirm_no" }]],
      },
    ]);

    await mcpClient.close();
    await server.close();
  });

  test("a push_message from fleetd is forwarded as notifications/claude/channel with string-only meta", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeEngine({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });

    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => {
      received = n;
    };

    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    expect(capturedPushHandler).toBeDefined();
    capturedPushHandler!({
      type: "push_message",
      text: "pesan baru dari Telegram",
      meta: { chat_id: "1", user_id: "2", ts: "2026-07-30T00:00:00Z" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(received.method).toBe("notifications/claude/channel");
    expect(received.params.content).toBe(`${USER_TURN_MARKER}\npesan baru dari Telegram`);
    for (const value of Object.values(received.params.meta)) {
      expect(typeof value).toBe("string"); // SCAR-056: every meta value must be a string
    }

    await mcpClient.close();
    await server.close();
  });

  test("a push_message meta containing a non-primitive value is serialized to a string before sending, never sent as an object/array", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeEngine({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => {
      received = n;
    };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    // Simulate what an album push would look like at the protocol boundary --
    // PushMessage.meta is already typed Record<string,string> upstream (fleetd side),
    // so this test exists to pin that buildServer never widens/breaks that guarantee
    // even if a future field is added; it passes an already-serialized multi-value
    // string (the realistic shape) and asserts it survives unchanged.
    capturedPushHandler!({
      type: "push_message",
      text: "album",
      meta: { chat_id: "1", attachments: "/a/1.jpg,/a/2.jpg" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received.params.meta.attachments).toBe("/a/1.jpg,/a/2.jpg");

    await mcpClient.close();
    await server.close();
  });

  test("a push_message meta containing genuinely non-string values (number, undefined) is coerced to strings, never passed through as-is", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeEngine({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => {
      received = n;
    };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    // PushMessage.meta is typed Record<string,string> upstream, but this test
    // pins the runtime-type-lie case SCAR-056 guards against: an upstream
    // caller that violates the type (e.g. a lost field from a partial spread,
    // or an optional field accessed but never set) must still never reach the
    // wire as a non-string. In particular, JSON.stringify(undefined) returns
    // the JS value `undefined` (not the string "undefined") -- a naive
    // fallback using JSON.stringify would silently drop this whole
    // notification. String(value) must be used instead.
    capturedPushHandler!({
      type: "push_message",
      text: "weird meta",
      meta: { chat_id: "1", count: 3 as any, missing: undefined as any },
    });
    await new Promise((r) => setTimeout(r, 50));

    for (const value of Object.values(received.params.meta)) {
      expect(typeof value).toBe("string");
    }
    expect(received.params.meta.count).toBe("3");
    expect(received.params.meta.missing).toBe("undefined");

    await mcpClient.close();
    await server.close();
  });

  test("the server declares MCP instructions that name the reply tool and the terse-turn marker", async () => {
    const client = fakeEngine();
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const instructions = mcpClient.getInstructions();

    // The protocol lives here (once per session) instead of being re-sent with
    // every push. If this is ever dropped, the per-turn marker becomes a
    // meaningless string the AI has no definition for.
    expect(instructions).toBeTruthy();
    expect(instructions).toContain(USER_TURN_MARKER);
    expect(instructions).toContain("reply");

    await mcpClient.close();
    await server.close();
  });

  test("a pushed message is stamped with the terse-turn marker while preserving the original text verbatim", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeEngine({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => { received = n; };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    capturedPushHandler!({
      type: "push_message",
      text: "tolong cek status deployment",
      meta: { chat_id: "1", user_id: "2", kind: "message" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // The marker leads so the AI reads it before the message itself.
    expect(received.params.content.startsWith(USER_TURN_MARKER)).toBe(true);
    // The user's own words must survive untouched -- the marker is additive.
    expect(received.params.content).toContain("tolong cek status deployment");
    // Structured fields keep travelling in meta, not in the text (SCAR-056).
    expect(received.params.meta.kind).toBe("message");

    await mcpClient.close();
    await server.close();
  });

  test("a button press (kind: callback) gets the same marker -- no special case", async () => {
    let capturedPushHandler: ((msg: PushMessage) => void) | undefined;
    const client = fakeEngine({ onPush: (handler) => { capturedPushHandler = handler; } });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    let received: any = null;
    mcpClient.fallbackNotificationHandler = async (n) => { received = n; };
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    capturedPushHandler!({
      type: "push_message",
      text: "confirm_yes",
      meta: { chat_id: "1", kind: "callback" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received.params.content).toBe(`${USER_TURN_MARKER}\nconfirm_yes`);

    await mcpClient.close();
    await server.close();
  });

  test("the read_history tool proxies to Engine.history and returns the rows as JSON", async () => {
    const calls: any[] = [];
    const row = {
      id: 7, ts: "t", bot: "bot-01", chatId: "111", messageId: "101", source: "user",
      userName: "mirza", text: "pesan kedua", replyTo: null, metadata: null,
    };
    const client = fakeEngine({
      history: async (opts: any) => {
        calls.push(opts);
        return [row];
      },
    });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result: any = await mcpClient.callTool({
      name: "read_history",
      arguments: { message_id: "101", after: 3 },
    });

    // snake_case at the tool boundary (what the AI sees, matching the meta keys
    // it was given), camelCase on the wire.
    expect(calls).toEqual([{ messageId: "101", after: 3 }]);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("pesan kedua");

    await mcpClient.close();
    await server.close();
  });

  test("the search_history tool proxies to Engine.search, and an argumen bot yang diselundupkan tidak ikut lewat", async () => {
    const calls: any[] = [];
    const client = fakeEngine({
      search: async (opts: any) => {
        calls.push(opts);
        return [];
      },
    });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result: any = await mcpClient.callTool({
      name: "search_history",
      arguments: { query: "backup", bot: "bot-02" }, // `bot` sudah tidak ada di schema
    });

    // Parameter `bot` dibuang 2026-08-04. Argumen yang tidak ada di schema
    // DIBUANG oleh lapisan MCP, jadi yang sampai ke Engine hanya query -- dan
    // itu yang dikunci: bukan "tidak dipakai", tapi "tidak pernah sampai".
    expect(calls).toEqual([{ query: "backup" }]);
    // An empty result reads as words, not as "[]" -- the AI should not have to
    // parse an empty array to learn nothing matched.
    expect(result.content[0].text).toContain("No messages");

    await mcpClient.close();
    await server.close();
  });

  test("a search that fleetd refuses comes back as a tool error, not as an empty result", async () => {
    const client = fakeEngine({
      search: async () => {
        throw new Error("request rejected: bad_search_query: unterminated string");
      },
    });
    const server = buildServer(client, testHome());

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result: any = await mcpClient.callTool({ name: "search_history", arguments: { query: 'backup"' } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("bad_search_query");

    await mcpClient.close();
    await server.close();
  });
});

// W-16, at the layer the AI actually touches. When the engine cannot start, the
// tools must still EXIST and must say why -- a plugin whose tools vanish is
// indistinguishable from one that was never installed, and that is precisely the
// failure that cost two hours on 2026-08-01 with no evidence left behind.
describe("cc-plugin MCP server when the engine could not start", () => {
  const unavailable = {
    kind: "unavailable" as const,
    reason: "this folder is not any bot's home; registered bots: bot-uji",
  };

  async function connected() {
    const server = buildServer(unavailable, testHome());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    return { server, mcpClient };
  }

  test("still registers every tool rather than hiding them", async () => {
    const { server, mcpClient } = await connected();

    const { tools } = await mcpClient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "agent_list",
      "agent_send",
      "agent_status",
      "read_history",
      "reply",
      "search_history",
      "send_slash",
    ]);

    await mcpClient.close();
    await server.close();
  });

  test("every tool answers with the reason, as an error the AI can read", async () => {
    const { server, mcpClient } = await connected();

    for (const call of [
      { name: "reply", arguments: { text: "halo" } },
      { name: "read_history", arguments: { message_id: "1" } },
      { name: "search_history", arguments: { query: "apa" } },
      { name: "agent_send", arguments: { to: "bot-03", text: "halo" } },
      { name: "agent_list", arguments: {} },
    ]) {
      const res = await mcpClient.callTool(call);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("bot-uji");
    }

    await mcpClient.close();
    await server.close();
  });
});

import { formatSendResult, REPLY_LENGTH_GUIDELINE, SERVER_INSTRUCTIONS } from "../src/server";

test("balasan pendek dilaporkan apa adanya, tanpa teguran", () => {
  expect(formatSendResult({ chars: 642, parts: 1, files: 0 })).toBe("sent (642 chars)");
});

test("hasil kirim menyebut jumlah berkas, supaya aturannya punya umpan balik", () => {
  expect(formatSendResult({ chars: 636, parts: 1, files: 2 })).toBe("sent (636 chars, 2 files)");
});

test("satu berkas ditulis tunggal", () => {
  expect(formatSendResult({ chars: 10, parts: 1, files: 1 })).toBe("sent (10 chars, 1 file)");
});

// Balasan teks biasa adalah mayoritas mutlak -- 110 dari 8.010 baris keluar yang
// pernah membawa berkas. Barisnya tidak boleh jadi lebih berisik hanya karena
// fitur ini ada.
test("balasan tanpa berkas tidak menyebut berkas sama sekali", () => {
  expect(formatSendResult({ chars: 10, parts: 1, files: 0 })).not.toContain("file");
});

// Aturan tanpa umpan balik akan luntur. Proyek ini sudah membayarnya sekali:
// parameter `format` di sistem lama yang seharusnya diingat AI, sampai user
// melihat **tebal** mendarat mentah di HP-nya.
test("balasan yang lewat pedoman menyebutkan itu -- ke AI, bukan ke user", () => {
  expect(formatSendResult({ chars: 1240, parts: 1, files: 0 })).toBe(
    "sent (1240 chars, over the 1000 guideline)"
  );
});

test("balasan berpotongan menyebut jumlah pesannya", () => {
  expect(formatSendResult({ chars: 5100, parts: 3, files: 0 })).toBe(
    "sent (5100 chars in 3 parts, over the 1000 guideline)"
  );
});

test("pedomannya satu angka bernama, bukan tersebar di beberapa tempat", () => {
  expect(REPLY_LENGTH_GUIDELINE).toBe(1000);
  expect(SERVER_INSTRUCTIONS).toContain("1000");
});

// Keputusan user 2026-08-05: kewajiban memasang jadwal timeout untuk
// `expects_reply` DIBUANG, tanpa pengganti. Biayanya dua tool call tiap kirim
// dan terasa sebagai jeda; yang dijaganya -- "tetangga tidak pernah menjawab"
// -- adalah keadaan yang sistem ini justru RANCANG (pesannya menunggu di
// inbox), dan lalu lintas antar-bot hari ini hampir selalu dimulai user, jadi
// user-lah yang menunggu dan menyadarinya lebih dulu.
//
// Assert NEGATIF, dan itu disengaja: yang harus dijaga bukan "aturan barunya
// ada" melainkan "aturan lamanya TIDAK KEMBALI". Kalimat itu hidup di
// SERVER_INSTRUCTIONS -- tidak ada kode yang gagal kalau ia muncul lagi.
describe("kewajiban jadwal timeout expects_reply sudah dibuang", () => {
  test("SERVER_INSTRUCTIONS tidak lagi menyuruh memasang jadwal", () => {
    expect(SERVER_INSTRUCTIONS).not.toContain("one-shot schedule");
    expect(SERVER_INSTRUCTIONS).not.toContain("cancel it when the answer lands");
  });

  test("deskripsi agent_send juga tidak menyuruhnya", async () => {
    const server = buildServer(fakeEngine(), testHome());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const { tools } = await mcpClient.listTools();
    const agentSend = tools.find((t) => t.name === "agent_send")!;
    expect(agentSend.description).not.toContain("one-shot schedule");

    await mcpClient.close();
    await server.close();
  });

  // Yang TIDAK ikut dibuang, dan sengaja dikunci di test yang sama: dua pagar
  // anti-loop. Keduanya ditegakkan kode, dan merekalah yang benar-benar
  // menahan lalu lintas antar-bot -- bukan jadwal timeout tadi.
  test("pagar anti-loop tetap ada", () => {
    expect(SERVER_INSTRUCTIONS).toContain("a reply may never itself ask for a reply");
    expect(SERVER_INSTRUCTIONS).toContain("enforced, not merely advised");
  });
});

// Dua aturan tentang teks yang dikirim ke AI, ditemukan user 2026-08-06 dan
// dikunci di sini karena SEBELUM test ini tidak ada satu pun kode yang gagal
// bila keduanya dilanggar -- keduanya hidup sebagai kebiasaan penulis, bukan
// sebagai syarat. Bentuknya sengaja mengikuti tetangganya di atas: yang harus
// dijaga bukan "kalimatnya pernah benar" melainkan "bentuk salahnya tidak
// kembali".
describe("SERVER_INSTRUCTIONS ditulis untuk pembacanya", () => {
  // Regex, bukan daftar kata: yang dijaga adalah KELASnya. Menguji
  // `not.toContain("AB-4")` hanya akan menangkap satu kasus yang kebetulan
  // sudah diperbaiki, dan diam untuk kode berikutnya yang menyusup.
  test("tidak memuat kode istilah internal", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\b(AB|K|W|B|TG|PTY|SCAR|SKILL)-\d+\b/);
  });

  // Fakta ini sudah ada di hooks/reply-guard.ts, tapi di sana ia baru dibaca
  // SESUDAH aturannya dilanggar. Menyatakannya di muka adalah satu-satunya
  // tempat ia masih bisa mencegah sesuatu.
  test("menegaskan user sedang AFK di muka, bukan hanya saat guard menyala", () => {
    expect(SERVER_INSTRUCTIONS).toContain("AFK");
  });
});

// Tanpa tool ini jalur antar-bot ada di kode tapi tidak bisa dipakai AI --
// rumahnya dibangun, penghuninya belum ada (persis nasib tabel `handoffs` di
// fleet.db: skema lengkap, nol baris kode memakainya).
describe("tool antar-bot", () => {
  async function connect(engine: Engine) {
    const server = buildServer(engine, testHome());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    return { server, mcpClient };
  }

  test("agent_send meneruskan ke engine dan mengembalikan id titipan", async () => {
    const calls: Array<{ to: string; text: string; opts: unknown }> = [];
    const { server, mcpClient } = await connect(
      fakeEngine({
        agentSend: (to, text, opts) => {
          calls.push({ to, text, opts });
          return { ok: true, id: "u-1", path: "p" };
        },
        agentPeers: () => ["bot-01", "bot-03"],
      } as Partial<Engine>)
    );

    const result = await mcpClient.callTool({
      name: "agent_send",
      arguments: { to: "bot-03", text: "halo" },
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.to).toBe("bot-03");
    expect(JSON.stringify(result.content)).toContain("u-1");

    await mcpClient.close();
    await server.close();
  });

  test("penolakan dilaporkan sebagai error yang bisa dibaca AI, bukan sukses palsu", async () => {
    const { server, mcpClient } = await connect(
      fakeEngine({
        agentSend: () => ({
          ok: false,
          error: "hop_count 6 melewati batas 5 -- menolak mengirim (anti-loop guard).",
        }),
        agentPeers: () => [],
      } as Partial<Engine>)
    );

    const result = await mcpClient.callTool({
      name: "agent_send",
      arguments: { to: "bot-03", text: "x", hop_count: 6 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("anti-loop");

    await mcpClient.close();
    await server.close();
  });

  test("agent_list menyebut tetangga yang benar-benar ada", async () => {
    const { server, mcpClient } = await connect(
      fakeEngine({
        agentSend: () => ({ ok: true, id: "u", path: "p" }),
        agentPeers: () => ["bot-01", "bot-03"],
      } as Partial<Engine>)
    );

    const result = await mcpClient.callTool({ name: "agent_list", arguments: {} });

    expect(JSON.stringify(result.content)).toContain("bot-01");
    expect(JSON.stringify(result.content)).toContain("bot-03");

    await mcpClient.close();
    await server.close();
  });

  // Tidak ada tetangga adalah keadaan sah, dan harus terbaca berbeda dari
  // "tidak bisa membaca folder induk". Daftar kosong yang tampak seperti
  // kegagalan membuat AI mencoba hal yang salah.
  test("tanpa tetangga, jawabannya kalimat -- bukan daftar kosong", async () => {
    const { server, mcpClient } = await connect(
      fakeEngine({
        agentSend: () => ({ ok: true, id: "u", path: "p" }),
        agentPeers: () => [],
      } as Partial<Engine>)
    );

    const result = await mcpClient.callTool({ name: "agent_list", arguments: {} });

    expect(JSON.stringify(result.content).length).toBeGreaterThan(20);

    await mcpClient.close();
    await server.close();
  });
});

// Tanpa test ini ada lubang yang tidak terlihat: test reply-guard membuat
// transcript dengan tangan, jadi mereka tetap hijau meski forwarder memasang
// penanda yang salah. Yang menghubungkan meta.origin ke penanda adalah fungsi
// ini, dan hanya ini.
describe("markerFor", () => {
  test("push dari bot lain memakai penanda agent-turn", () => {
    expect(markerFor({ origin: "agent", from_bot: "bot-03" })).toBe(AGENT_TURN_MARKER);
  });

  test("push dari Telegram memakai penanda terse-turn", () => {
    expect(markerFor({ chat_id: "111", kind: "message" })).toBe(USER_TURN_MARKER);
  });

  test("origin yang tidak dikenal diperlakukan sebagai Telegram, bukan sebaliknya", () => {
    // Arah default-nya penting: salah menandai pesan Telegram sebagai antar-bot
    // MEMATIKAN reply-guard dan membuat user tidak dijawab -- kegagalan paling
    // mahal di proyek ini. Salah arah sebaliknya cuma bikin guard cerewet.
    expect(markerFor({ origin: "entah-apa" })).toBe(USER_TURN_MARKER);
    expect(markerFor({})).toBe(USER_TURN_MARKER);
  });
});

// Tanpa tool ini, memindahkan cc-wrapper ke slash/ membuka jendela di mana bot
// baru TIDAK BISA me-/rename dirinya sendiri -- dan itu dipakai tiap handoff.
describe("tool send_slash", () => {
  async function connectWith(home: string, backend: any = fakeEngine()) {
    const server = buildServer(backend, home);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    return { server, mcpClient };
  }

  function payloadsIn(home: string): unknown[] {
    // Brief-verbatim helper punya satu tambahan: `slash/` hanya dibuat oleh
    // writePending saat sukses, jadi kasus "ditolak, tidak meninggalkan
    // berkas" bertemu folder yang belum pernah ada sama sekali. Folder yang
    // tidak ada berarti nol payload, bukan galat -- existsSync ini tidak
    // mengubah satu pun assertion, hanya membuat pembacaannya tahan pada
    // keadaan itu.
    if (!existsSync(slashDirIn(home))) return [];
    return readdirSync(slashDirIn(home))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(joinPath(slashDirIn(home), f), "utf8")));
  }

  test("perintah tunggal ditulis ke <botHome>/slash", async () => {
    const home = testHome();
    const { server, mcpClient } = await connectWith(home);

    const result: any = await mcpClient.callTool({
      name: "send_slash",
      arguments: { command: "/rename sesi-baru" },
    });

    expect(result.isError).toBeFalsy();
    expect(payloadsIn(home)).toEqual([{ command: "/rename sesi-baru" }]);

    await mcpClient.close();
    await server.close();
  });

  test("batch ditulis sebagai SATU berkas array, bukan beberapa berkas", async () => {
    const home = testHome();
    const { server, mcpClient } = await connectWith(home);

    await mcpClient.callTool({
      name: "send_slash",
      arguments: { commands: ["/rename done-x", "/clear", "/rename idle"] },
    });

    const payloads = payloadsIn(home);
    // Satu berkas: itulah yang membuat batch atomik. Tiga berkas terpisah bisa
    // diselipi payload lain di antaranya, dan urutan reset-sesi akan pecah.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual([
      { command: "/rename done-x" },
      { command: "/clear" },
      { command: "/rename idle" },
    ]);

    await mcpClient.close();
    await server.close();
  });

  test("input yang ditolak dijawab sebagai error, dan TIDAK meninggalkan berkas", async () => {
    const home = testHome();
    const { server, mcpClient } = await connectWith(home);

    const result: any = await mcpClient.callTool({
      name: "send_slash",
      arguments: { command: "/new sesi-x" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("/clear");
    // Kalau berkasnya tetap ditulis, penolakannya bohong -- perintahnya tetap
    // berangkat dan AI diberi tahu sebaliknya.
    expect(payloadsIn(home)).toEqual([]);

    await mcpClient.close();
    await server.close();
  });

  // §3.3 spec. Ini kriteria yang paling mudah dilewati dan paling langsung
  // membuktikan kenapa send_slash tidak menumpang Engine.
  test("TETAP BEKERJA saat engine gagal start", async () => {
    const home = testHome();
    const { server, mcpClient } = await connectWith(home, {
      kind: "unavailable" as const,
      reason: "config.json tidak terbaca",
    });

    const result: any = await mcpClient.callTool({
      name: "send_slash",
      arguments: { command: "/clear" },
    });

    expect(result.isError).toBeFalsy();
    expect(payloadsIn(home)).toEqual([{ command: "/clear" }]);

    await mcpClient.close();
    await server.close();
  });

  test("terdaftar juga saat engine mati", async () => {
    const { server, mcpClient } = await connectWith(testHome(), {
      kind: "unavailable" as const,
      reason: "apa pun",
    });

    const { tools } = await mcpClient.listTools();
    expect(tools.map((t) => t.name)).toContain("send_slash");

    await mcpClient.close();
    await server.close();
  });

  // Keputusan user 2026-06-07 (neighbor autonomy), ditegakkan oleh BENTUK:
  // tidak ada parameter tujuan, jadi tidak ada yang bisa dialamatkan ke luar.
  test("self-only -- tidak ada parameter target di schema", async () => {
    const { server, mcpClient } = await connectWith(testHome());

    const { tools } = await mcpClient.listTools();
    const tool = tools.find((t) => t.name === "send_slash")!;
    const props = Object.keys((tool.inputSchema as any).properties ?? {});
    expect(props.sort()).toEqual(["command", "commands"]);

    await mcpClient.close();
    await server.close();
  });
});

// Barang terlupa keempat (2026-08-06): sistem lama punya skill `immediate-reply`
// yang mewajibkan ack sebelum tool call pertama; sistem baru tidak punya apa pun
// soal itu -- `grep` "immediate|acknowledge|before.*tool call" = nol. Ditemukan
// karena user menanyakannya, bukan oleh audit: ack bukan sesuatu yang user
// KETIK, jadi ia tidak berjejak di `messages.db` maupun `wrapper.log`.
//
// reply-guard TIDAK menutup celah ini: ia menjaga UJUNG giliran (harus ada
// `reply` sebelum berakhir), bukan awalnya. Giliran lima menit lolos dengan
// mulus asal akhirnya membalas -- dan lima menit sunyi itu, dari sisi user,
// tidak bisa dibedakan dari bot yang menggantung.
describe("kewajiban ack sebelum tool call pertama", () => {
  test("SERVER_INSTRUCTIONS menyuruh mengirim ack lebih dulu", () => {
    // Case-insensitive dengan sengaja: kapitalisasi "BEFORE" adalah penekanan
    // untuk pembacanya, bukan bagian dari aturan. Test yang mengunci huruf
    // besar akan merah karena hal yang tidak ia maksudkan jaga.
    expect(SERVER_INSTRUCTIONS).toMatch(/before your first tool call/i);
  });

  // Kalimat perintah, bukan pernyataan keadaan (keputusan user 2026-08-06):
  // kalimat yang cuma menyatakan keadaan akan dikarang maksudnya oleh AI.
  // Yang dijaga di sini bukan kata "AFK"-nya -- itu tetangga di atas -- tapi
  // bahwa aturannya menyebut AKIBAT kalau diabaikan, bukan cuma menyuruh.
  test("menyebut akibatnya, bukan cuma perintahnya", () => {
    expect(SERVER_INSTRUCTIONS).toContain("cannot tell whether you are working or hung");
  });

  // Tanpa jalan keluar yang eksplisit, aturan mekanis begini akan ditaati
  // secara harfiah pada giliran yang cuma membaca satu berkas -- dan berubah
  // jadi spam yang user sendiri harus matikan.
  test("punya pengecualian eksplisit untuk giliran tanpa tool", () => {
    expect(SERVER_INSTRUCTIONS).toContain("no tool calls at all");
  });
});

// Keputusan user 2026-08-06: penanda menamai SUMBER, bukan perilaku.
//
// Sebelumnya keduanya memakai awalan `protocol:` yang sama padahal berada di
// sumbu berbeda -- `agent-turn` menyebut siapa pengirimnya, `terse-turn`
// menyebut apa yang harus dilakukan. Ketidakkonsistenan itu tidak menggigit
// selama cuma ada dua; ia menggigit saat penulis KETIGA (mesin) butuh nama,
// karena nama apa pun yang dipilih akan miring ke salah satu sumbu.
//
// Alasan memilih sumbu SUMBER, dan ini bukan soal kerapian: mesin TAHU PASTI
// dari mana sebuah pesan masuk, dan TIDAK tahu perilaku apa yang pantas -- itu
// tergantung isi pesannya, yang wilayah AI. Penanda yang menyebut perilaku
// adalah mesin mengambil keputusan yang bukan haknya.
//
// Nilainya sebelum ini tidak dijaga apa pun: mengganti isi kedua konstanta
// tidak membuat satu test pun merah.
describe("penanda menamai sumber, bukan perilaku", () => {
  test("penanda user menyebut pengirimnya", () => {
    expect(USER_TURN_MARKER).toBe("[from: user]");
  });

  test("penanda antar-bot menyebut pengirimnya", () => {
    expect(AGENT_TURN_MARKER).toBe("[from: agent]");
  });

  test("penanda mesin menyebut pengirimnya", () => {
    expect(SYSTEM_TURN_MARKER).toBe("[from: system]");
  });

  // Yang dijaga bukan tiga kata itu, melainkan bahwa ketiganya tetap berada di
  // SATU sumbu. Penanda berikutnya yang menyusul pola lama akan merah di sini.
  //
  // Penanda mesin ikut di sini sejak 2026-08-09. Sebelumnya loop ini cuma
  // memuat dua, dan pengecualiannya tidak disengaja -- ia lahir dari test yang
  // ditulis saat penanda ketiga belum ada, lalu tidak ikut tumbuh. Daftar yang
  // ditulis tangan selalu punya kegagalan berbentuk ini: yang hilang tidak
  // membuat apa pun merah.
  test("ketiganya berbentuk sama, supaya penanda berikutnya punya cetakan", () => {
    for (const m of [USER_TURN_MARKER, AGENT_TURN_MARKER, SYSTEM_TURN_MARKER]) {
      expect(m).toMatch(/^\[from: [a-z]+\]$/);
    }
  });
});

// Konsekuensi langsung dari memilih sumbu SUMBER: nama penanda tidak lagi
// memberi tahu apa yang harus dilakukan, jadi hubungan sumber -> perilaku harus
// dinyatakan. Tanpa kalimat ini, `[from: user]` cuma label tanpa akibat -- dan
// aturan yang tidak menyebut akibatnya akan dikarang lengkap oleh pembacanya.
test("SERVER_INSTRUCTIONS menjelaskan bahwa penanda menyebut asal, bukan perintah", () => {
  expect(SERVER_INSTRUCTIONS).toContain("names where it came from");
});

// Sebuah penanda yang dikirim ke AI tanpa pernah dijelaskan ke AI adalah
// setengah kontrak: mesinnya memenuhi bagiannya, pembacanya tidak pernah
// diberi bagiannya. Sampai 2026-08-09 `[from: system]` persis begitu -- ia
// menempel di setiap push yang pengingatnya menyala, dan tidak ada satu
// kalimat pun di seluruh instructions yang menyebutnya.
//
// Yang membuatnya bertahan lama: tidak ada yang gagal. Kalimat pembuka
// instructions tetap BENAR (hanya user dan agent yang pernah MEMIMPIN pesan),
// jadi tidak ada pernyataan salah yang bisa ditangkap. Yang bolong adalah
// janji di kalimat sesudahnya -- "the rules below are what each source means".
describe("SERVER_INSTRUCTIONS memperkenalkan penulis ketiga", () => {
  test("penanda mesin disebut, bukan cuma dikirim", () => {
    expect(SERVER_INSTRUCTIONS).toContain(SYSTEM_TURN_MARKER);
  });

  // Bukan sekadar "ada namanya". Yang harus sampai adalah SIAPA penulisnya,
  // karena tanpa itu AI tidak punya dasar untuk curiga saat user mengetik
  // string ini sendiri -- batas yang sudah disadari sejak penanda antar-bot.
  test("penulisnya dinyatakan mesin, bukan manusia dan bukan bot", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/written by the machine/i);
  });

  // Kalimat ini menjaga kalimat pembuka tetap koheren. Tanpa "never leads",
  // pembaca yang menemukan penanda ini di tengah badan pesan punya alasan
  // menyangka daftar di kalimat pembuka sudah lengkap dan ia salah baca.
  test("dinyatakan tidak pernah memimpin pesan", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/never leads a message/i);
  });

  // Kewajiban yang dulu cuma hidup di komentar `reminders.ts`. Keputusan user
  // 2026-08-06: mesin tidak menyusun prioritas, AI yang menyusun, dan AI boleh
  // mengembalikan keputusannya ke user. Aturan yang tidak pernah sampai ke
  // pelaksananya bukan aturan -- ia keberuntungan yang kebetulan berulang.
  test("kontrak prioritas diserahkan ke AI, dan boleh dikembalikan ke user", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/does NOT rank what to do first/);
    expect(SERVER_INSTRUCTIONS).toContain("hand it back to the user");
  });
});

// Aturan punya NAMA, bukan nomor (spec 2026-08-10 K-1), dan penjelasan TIDAK
// ikut dinamai (K-2). Yang dijaga di sini bukan nama-namanya, melainkan bahwa
// perakitannya tidak bisa diam-diam menghasilkan aturan yang tidak pernah
// sampai ke pembacanya -- kegagalan yang persis sebentuk dengan `[from: system]`
// yang dikirim bertahun-tahun tanpa pernah diperkenalkan (0.37.2).
describe("aturan bernama di dalam instructions", () => {
  test("setiap aturan muncul dengan judulnya, bukan cuma ada di daftar", () => {
    expect(RULE_IDS.length).toBeGreaterThan(0);
    for (const id of RULE_IDS) {
      expect(SERVER_INSTRUCTIONS).toContain(`Rule ${id}:`);
    }
  });

  // Nama yang kembar membuat rujukan jadi ambigu justru saat ia paling
  // dibutuhkan: teguran menyebut satu nama, dan pembacanya menemukan dua
  // kalimat berbeda yang sama-sama mengaku bernama itu.
  test("nama aturan unik", () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });

  // Bentuk namanya dijaga sekarang, saat baru enam, supaya penambah berikutnya
  // punya cetakan. Daftar yang bentuknya tidak pernah dijaga akan menumbuhkan
  // `replyLength`, `Reply_Length`, dan `reply length` dalam setahun.
  test("nama aturan berbentuk kebab-case", () => {
    for (const id of RULE_IDS) {
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  // Pemecahan paragraf terse-turn (K-3). Kalau keduanya menyatu lagi, catatan
  // pelanggaran berhenti bisa membedakan "diam" dari "boros" -- dua kegagalan
  // yang obatnya berlawanan, dan satu-satunya alasan pemecahan ini ada.
  test("diam dan boros adalah dua aturan terpisah", () => {
    expect(RULE_IDS).toContain("reply-required");
    expect(RULE_IDS).toContain("no-prose");
  });

  test("blok penjelasan TIDAK diberi judul aturan", () => {
    const penjelasan = INSTRUCTION_BLOCKS.filter((b) => b.id === undefined);

    expect(penjelasan.length).toBeGreaterThan(0);
    for (const b of penjelasan) {
      expect(SERVER_INSTRUCTIONS).toContain(b.text);
      expect(SERVER_INSTRUCTIONS).not.toContain(`Rule undefined: ${b.text}`);
    }
  });

  // Perakitannya murni, jadi bisa diadu dengan daftar karangan -- tanpa itu
  // satu-satunya cara mengujinya adalah lewat teks nyata, yang ikut berubah
  // tiap kali kalimat aturannya disunting.
  test("renderInstructions memberi judul hanya pada yang ber-id", () => {
    const out = renderInstructions([{ text: "penjelasan" }, { id: "contoh", text: "aturan" }]);

    expect(out).toBe("penjelasan\n\nRule contoh: aturan");
  });
});
