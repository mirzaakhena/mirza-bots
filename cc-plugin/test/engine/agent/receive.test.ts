import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainInbox, startInboxScanner, AGENT_ORIGIN } from "../../../src/engine/agent/receive";
import { CollectingSink } from "../../../src/engine/sink";
import { inboxDirIn } from "../../../src/engine/paths";

function botWithInbox(): string {
  const home = join(mkdtempSync(join(tmpdir(), "recv-")), "bot-02");
  mkdirSync(inboxDirIn(home), { recursive: true });
  return home;
}

function drop(home: string, name: string, body: unknown): void {
  writeFileSync(join(inboxDirIn(home), name), JSON.stringify(body));
}

const good = {
  id: "u-1",
  ts: "2026-08-04T22:00:00Z",
  from: "bot-03",
  text: "kerjakan X",
  expects_reply: true,
  hop_count: 1,
};

describe("drainInbox", () => {
  test("mendorong pesan sah ke AI dengan penanda sumber", () => {
    const home = botWithInbox();
    drop(home, "u-1.json", good);
    const sink = new CollectingSink("sess-1");

    expect(drainInbox(home, sink)).toBe(1);
    expect(sink.sent.length).toBe(1);
    expect(sink.sent[0]!.text).toContain("kerjakan X");
  });

  // Penanda sumber adalah SYARAT, bukan fitur. Tanpanya reply-guard membaca
  // pesan antar-bot sebagai pesan Telegram yang belum dijawab dan menuntut
  // `reply` ke chat user -- pengulangan W-14, dan chat user disemprot setiap
  // kali dua bot berbicara.
  test("meta membawa origin, pengirim, dan id yang bisa dibalas", () => {
    const home = botWithInbox();
    drop(home, "u-1.json", good);
    const sink = new CollectingSink("sess-1");

    drainInbox(home, sink);

    const meta = sink.sent[0]!.meta;
    expect(meta.origin).toBe(AGENT_ORIGIN);
    expect(meta.from_bot).toBe("bot-03");
    expect(meta.agent_message_id).toBe("u-1");
    expect(meta.expects_reply).toBe("true");
    expect(meta.hop_count).toBe("1");
    expect(meta.session_id).toBe("sess-1");
  });

  // SCAR-056: meta Claude Code bertipe Record<string,string> ketat. Nilai
  // non-string membuat SELURUH notifikasi dijatuhkan tanpa error di mana pun.
  test("setiap nilai meta adalah string", () => {
    const home = botWithInbox();
    drop(home, "u-1.json", good);
    const sink = new CollectingSink();

    drainInbox(home, sink);

    for (const value of Object.values(sink.sent[0]!.meta)) {
      expect(typeof value).toBe("string");
    }
  });

  test("berkas dihapus sesudah dibaca -- tidak diproses dua kali", () => {
    const home = botWithInbox();
    drop(home, "u-1.json", good);
    const sink = new CollectingSink();

    drainInbox(home, sink);

    expect(readdirSync(inboxDirIn(home)).length).toBe(0);
    expect(drainInbox(home, sink)).toBe(0);
  });

  test("berkas .tmp diabaikan -- penulisnya belum selesai", () => {
    const home = botWithInbox();
    writeFileSync(join(inboxDirIn(home), "u-9.json.tmp.123"), "{sedang ditulis");
    const sink = new CollectingSink();

    expect(drainInbox(home, sink)).toBe(0);
    // Dibiarkan, bukan dihapus: ia milik proses lain yang sedang menulis.
    expect(readdirSync(inboxDirIn(home)).length).toBe(1);
  });

  test("berkas non-JSON diabaikan, tidak dihapus", () => {
    const home = botWithInbox();
    writeFileSync(join(inboxDirIn(home), "catatan.txt"), "bukan payload");
    const sink = new CollectingSink();

    expect(drainInbox(home, sink)).toBe(0);
    expect(readdirSync(inboxDirIn(home)).length).toBe(1);
  });

  test("payload rusak dilaporkan, tidak mendorong apa pun ke AI", () => {
    const home = botWithInbox();
    writeFileSync(join(inboxDirIn(home), "rusak.json"), "{bukan json");
    const sink = new CollectingSink();
    const rejected: string[] = [];

    expect(drainInbox(home, sink, (f) => rejected.push(f))).toBe(0);

    expect(sink.sent.length).toBe(0);
    expect(rejected).toEqual(["rusak.json"]);
  });

  test("payload yang melanggar aturan balasan ditolak di sisi penerima juga", () => {
    const home = botWithInbox();
    drop(home, "u-2.json", { ...good, in_reply_to: "z" });
    const sink = new CollectingSink();

    expect(drainInbox(home, sink)).toBe(0);
    expect(sink.sent.length).toBe(0);
  });

  test("inbox yang belum ada bukan kesalahan", () => {
    const home = join(mkdtempSync(join(tmpdir(), "recv-")), "bot-02");
    mkdirSync(home, { recursive: true });

    expect(drainInbox(home, new CollectingSink())).toBe(0);
  });

  test("beberapa pesan sekaligus semuanya sampai", () => {
    const home = botWithInbox();
    drop(home, "u-1.json", good);
    drop(home, "u-2.json", { ...good, id: "u-2", text: "dan Y", expects_reply: false });
    const sink = new CollectingSink();

    expect(drainInbox(home, sink)).toBe(2);
    expect(sink.sent.map((m) => m.text).sort()).toEqual(["dan Y", "kerjakan X"]);
  });
});

describe("startInboxScanner", () => {
  test("mengembalikan penghenti, dan sesudah dihentikan tidak memindai lagi", async () => {
    const home = botWithInbox();
    const sink = new CollectingSink();
    const stop = startInboxScanner(home, sink, 10);

    drop(home, "u-1.json", good);
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.sent.length).toBe(1);

    stop();
    drop(home, "u-2.json", { ...good, id: "u-2", text: "sesudah berhenti" });
    await new Promise((r) => setTimeout(r, 60));

    // Yang dibuktikan adalah KETIADAAN: pesan kedua tidak pernah didorong, dan
    // berkasnya masih utuh di folder.
    expect(sink.sent.length).toBe(1);
    expect(readdirSync(inboxDirIn(home)).length).toBe(1);
  });
});
