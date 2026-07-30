import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A minimal fake Telegram Bot API covering exactly the calls grammy's polling
// loop, sendMessage, and callback_query handling make: deleteWebhook (called
// once before long-polling starts), getMe (bot identity), getUpdates
// (long-poll -- serves each queued update once, in order, then empties out),
// sendMessage (records what was sent, including reply_markup for button
// tests), and answerCallbackQuery (records which callback_query_id was
// acknowledged -- this is the assertion that catches the "spinner forever"
// scar tissue if a future change ever drops the ctx.answerCallbackQuery() call).
type FakeTelegram = {
  server: ReturnType<typeof Bun.serve>;
  sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }>;
  answeredCallbackIds: string[];
};

// `failSendMessageForText` makes /sendMessage answer like a real Telegram
// rejection (HTTP 400 + ok:false) for exactly one message text, so a test can
// prove fleetd still writes a response line instead of hanging its client.
function startFakeTelegramApi(
  queuedUpdates: unknown[],
  opts: { failSendMessageForText?: string } = {}
): FakeTelegram {
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbackIds: string[] = [];
  let getUpdatesCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/deleteWebhook")) {
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith("/getMe")) {
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "test", username: "test_bot" },
        });
      }
      if (url.pathname.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls <= queuedUpdates.length) {
          return Response.json({ ok: true, result: [queuedUpdates[getUpdatesCalls - 1]] });
        }
        // Emulate long polling once the queue is drained -- without this the
        // daemon would hammer this server in a tight loop for the whole test.
        await Bun.sleep(250);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith("/sendMessage")) {
        const body = (await req.json()) as {
          chat_id: string;
          text: string;
          reply_markup?: unknown;
        };
        if (opts.failSendMessageForText !== undefined && body.text === opts.failSendMessageForText) {
          return Response.json(
            { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            { status: 400 }
          );
        }
        sentMessages.push({
          chat_id: String(body.chat_id),
          text: body.text,
          reply_markup: body.reply_markup,
        });
        return Response.json({
          ok: true,
          result: {
            message_id: sentMessages.length,
            date: 0,
            chat: { id: body.chat_id, type: "private" },
            text: body.text,
          },
        });
      }
      if (url.pathname.endsWith("/answerCallbackQuery")) {
        const body = (await req.json()) as { callback_query_id: string };
        answeredCallbackIds.push(body.callback_query_id);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  return { server, sentMessages, answeredCallbackIds };
}

// Opens a socket client to fleetd and collects newline-delimited response lines.
async function connectToFleetd(sockPath: string): Promise<{
  client: import("node:net").Socket;
  lines: string[];
}> {
  const net = await import("node:net");
  const client = net.createConnection(sockPath);
  const lines: string[] = [];
  let buf = "";
  client.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      lines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  await new Promise<void>((resolve) => client.on("connect", resolve));
  return { client, lines };
}

// Polls conversations.db directly (no socket query API yet) until `term` shows up
// or the budget runs out; returns how many matches were found.
async function waitForStoredMessage(convDbPath: string, term: string, budgetMs = 8000) {
  const { openConversationsDb, searchMessages } = await import("../src/db/conversations-schema");
  let count = 0;
  for (let waited = 0; waited < budgetMs && count === 0; waited += 100) {
    await Bun.sleep(100);
    if (!existsSync(convDbPath)) continue;
    const db = openConversationsDb(convDbPath);
    count = searchMessages(db, term).length;
    db.close();
  }
  return count;
}

// Waits for the socket server to have written at least `n` response lines --
// the assertion that a request was ANSWERED rather than silently dropped.
async function waitForLines(lines: string[], n: number, budgetMs = 5000) {
  for (let waited = 0; waited < budgetMs && lines.length < n; waited += 50) {
    await Bun.sleep(50);
  }
  return lines.length;
}

describe("fleetd end-to-end", () => {
  const root = join(import.meta.dir, "..");
  let home: string;
  let env: Record<string, string | undefined>;
  let fleetdProc: Bun.Subprocess;

  // Setup lives in beforeAll, not the describe body: hooks only run when this
  // suite's tests are actually selected, so the spawned daemon is always paired
  // with the afterAll that kills it, even under `bun test -t ...` filtering.
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "mirza-bots-e2e-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        allowFrom: ["123456"],
        bots: { "bot-01": { home: "/tmp/bot-01", token: "test-token" } },
      })
    );

    // TELEGRAM_API_ROOT points at a closed local port on purpose: this suite only
    // exercises the doctor path, but main.ts now starts pollers, and no test in
    // this file may ever touch the real Telegram API. The poller's retry loop just
    // keeps failing quietly against the dead port.
    env = { ...process.env, MIRZA_BOTS_HOME: home, TELEGRAM_API_ROOT: "http://127.0.0.1:1" };
    fleetdProc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  afterAll(() => {
    fleetdProc.kill();
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor reports 1 registered bot and all fleet tables", async () => {
    const sockPath = join(home, "fleetd.sock");
    let waited = 0;
    while (!existsSync(sockPath) && waited < 3000) {
      await Bun.sleep(100);
      waited += 100;
    }
    if (!existsSync(sockPath)) {
      const [stdout, stderr] = await Promise.all([
        new Response(fleetdProc.stdout).text(),
        new Response(fleetdProc.stderr).text(),
      ]);
      throw new Error(
        `fleetd socket never appeared at ${sockPath} after ${waited}ms.\n` +
          `--- fleetd stdout ---\n${stdout}\n--- fleetd stderr ---\n${stderr}`
      );
    }
    expect(existsSync(sockPath)).toBe(true);

    const doctorProc = Bun.spawn(["bun", "run", "bin/fleetd-doctor.ts"], {
      cwd: root,
      env,
      stdout: "pipe",
    });
    const output = await new Response(doctorProc.stdout).text();
    await doctorProc.exited;

    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.report.botCount).toBe(1);
    expect(parsed.report.fleetTables.length).toBe(5);
    expect(parsed.report.conversationsReady).toBe(true);
  });
});

// New describe block -- separate from Tahap 1's, so it gets its own beforeAll/afterAll
// with the fake Telegram API wired in via TELEGRAM_API_ROOT.
describe("fleetd Tahap 2 end-to-end: poll, store, push, reply", () => {
  const root = join(import.meta.dir, "..");
  const queuedUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 111, type: "private" },
      from: { id: 111, is_bot: false, first_name: "mirza" },
      text: "halo bot",
    },
  };

  // The one text the fake Telegram API is configured to reject, used by the
  // send-failure test below.
  const REJECTED_TEXT = "teks yang ditolak Telegram";

  let home: string;
  let fake: FakeTelegram;
  let fleetdProc: Bun.Subprocess;

  // Everything that allocates an OS resource (temp dir, HTTP server, daemon
  // process) lives in beforeAll so it is always paired with the afterAll that
  // releases it, even under `bun test -t ...` filtering.
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "mirza-bots-e2e-t2-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        allowFrom: ["111"],
        bots: { "bot-01": { home: "/tmp/bot-01", token: "fake:token" } },
      })
    );
    fake = startFakeTelegramApi([queuedUpdate], { failSendMessageForText: REJECTED_TEXT });
    fleetdProc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        MIRZA_BOTS_HOME: home,
        TELEGRAM_API_ROOT: `http://localhost:${fake.server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  afterAll(() => {
    fleetdProc.kill();
    fake.server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("an update from the fake Telegram API is stored, then reply sends via the fake API", async () => {
    // Wait for the message to be polled and stored (querying conversations.db over
    // the socket isn't wired for arbitrary queries yet, so poll the file directly
    // for a bounded time instead of sleeping a fixed guess).
    const convDbPath = join(home, "conversations.db");
    expect(await waitForStoredMessage(convDbPath, "halo")).toBeGreaterThan(0);

    // Trigger a reply over the socket, identified as bot-01 via hello (matching
    // config.json's bots["bot-01"].home).
    const sockPath = join(home, "fleetd.sock");
    const { encode } = await import("../src/socket/protocol");
    const { client, lines } = await connectToFleetd(sockPath);

    client.write(encode({ type: "hello", cwd: "/tmp/bot-01" }));
    await Bun.sleep(100);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });

    client.write(encode({ type: "reply", text: "balasan AI" }));
    await Bun.sleep(300);
    expect(JSON.parse(lines[1]!)).toEqual({ ok: true });

    expect(fake.sentMessages[0]).toEqual({
      chat_id: "111",
      text: "balasan AI",
      reply_markup: undefined,
    });
    client.end();
    // Timeout well above the wait budgets below so a genuine regression fails on a
    // readable expect(), not on bun's default 5s test timeout.
  }, 20000);

  test("a reply Telegram rejects still gets a response line back -- the client never hangs", async () => {
    // The reply target comes from the polled update, so make sure it has landed
    // even when this test runs alone under `bun test -t ...`.
    const convDbPath = join(home, "conversations.db");
    expect(await waitForStoredMessage(convDbPath, "halo")).toBeGreaterThan(0);

    const sockPath = join(home, "fleetd.sock");
    const { encode } = await import("../src/socket/protocol");
    const { client, lines } = await connectToFleetd(sockPath);

    client.write(encode({ type: "hello", cwd: "/tmp/bot-01" }));
    expect(await waitForLines(lines, 1)).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });

    // The fake API answers this exact text with HTTP 400 + ok:false, which grammy
    // surfaces as a thrown GrammyError inside the reply handler.
    client.write(encode({ type: "reply", text: REJECTED_TEXT }));
    expect(await waitForLines(lines, 2)).toBe(2);

    const res = JSON.parse(lines[1]!);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("send_failed");

    // The connection is still usable afterwards -- the failure did not wedge it.
    client.write(encode({ type: "reply", text: "balasan setelah gagal" }));
    expect(await waitForLines(lines, 3)).toBe(3);
    expect(JSON.parse(lines[2]!)).toEqual({ ok: true });

    client.end();
  }, 20000);
});

// Separate describe block, its own fleetd + fake Telegram instance, dedicated to
// buttons: a callback_query update (button press) and a reply carrying buttons.
describe("fleetd Tahap 2 end-to-end: buttons", () => {
  const root = join(import.meta.dir, "..");
  const queuedCallbackUpdate = {
    update_id: 1,
    callback_query: {
      id: "cbq-1",
      from: { id: 111, is_bot: false, first_name: "mirza" },
      message: {
        message_id: 5,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 111, type: "private" },
      },
      chat_instance: "abc",
      data: "confirm_yes",
    },
  };

  let home: string;
  let fake: FakeTelegram;
  let fleetdProc: Bun.Subprocess;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "mirza-bots-e2e-t2-buttons-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        allowFrom: ["111"],
        bots: { "bot-01": { home: "/tmp/bot-01", token: "fake:token" } },
      })
    );
    fake = startFakeTelegramApi([queuedCallbackUpdate]);
    fleetdProc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        MIRZA_BOTS_HOME: home,
        TELEGRAM_API_ROOT: `http://localhost:${fake.server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  afterAll(() => {
    fleetdProc.kill();
    fake.server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("a button press is acknowledged via answerCallbackQuery and stored/pushed, then reply-with-buttons sends the right reply_markup", async () => {
    // The critical scar-tissue assertion: answerCallbackQuery was actually called,
    // with the exact callback_query_id from the update -- not just "the handler ran."
    let answered = false;
    for (let waited = 0; waited < 8000 && !answered; waited += 100) {
      await Bun.sleep(100);
      answered = fake.answeredCallbackIds.includes("cbq-1");
    }
    expect(answered).toBe(true);

    // The press was stored as a message (searchable by its callback data).
    const convDbPath = join(home, "conversations.db");
    expect(await waitForStoredMessage(convDbPath, "confirm_yes", 4000)).toBe(1);

    // Now send a reply WITH buttons and confirm the fake API received the right
    // inline_keyboard shape.
    const sockPath = join(home, "fleetd.sock");
    const { encode } = await import("../src/socket/protocol");
    const { client, lines } = await connectToFleetd(sockPath);

    client.write(encode({ type: "hello", cwd: "/tmp/bot-01" }));
    await Bun.sleep(100);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });

    client.write(
      encode({
        type: "reply",
        text: "Pilih salah satu:",
        buttons: [
          [
            { text: "Ya", data: "confirm_yes" },
            { text: "Tidak", data: "confirm_no" },
          ],
        ],
      })
    );
    await Bun.sleep(300);
    expect(JSON.parse(lines[1]!)).toEqual({ ok: true });

    const sent = fake.sentMessages.find((m) => m.text === "Pilih salah satu:");
    expect(sent?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Ya", callback_data: "confirm_yes" },
          { text: "Tidak", callback_data: "confirm_no" },
        ],
      ],
    });

    client.end();
    // See the timeout note in the sibling suite above.
  }, 20000);
});
