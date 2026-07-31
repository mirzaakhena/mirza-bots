import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

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

// Opens a socket client to fleetd and collects newline-delimited lines, split into
// two streams: `lines` for request/response traffic and `pushes` for unsolicited
// push_message notifications. They must be separated -- fleetd pushes the offline
// queue right after a hello, so a single flat array would interleave a drained
// message in between a request and its response and make positional assertions
// (lines[0], lines[1], ...) depend on whether anything happened to be queued.
async function connectToFleetd(sockPath: string): Promise<{
  client: import("node:net").Socket;
  lines: string[];
  pushes: string[];
}> {
  const net = await import("node:net");
  const client = net.createConnection(sockPath);
  const lines: string[] = [];
  const pushes: string[] = [];
  let buf = "";
  client.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        lines.push(line);
        continue;
      }
      if (parsed?.type === "push_message") pushes.push(line);
      else lines.push(line);
    }
  });
  await new Promise<void>((resolve) => client.on("connect", resolve));
  return { client, lines, pushes };
}

// Readiness gate for a spawned fleetd.
//
// Deliberately NOT fs.existsSync(): on Windows the socket is a real AF_UNIX
// endpoint whose backing file cannot be stat()ed (EACCES), so existsSync answers
// false for a perfectly healthy socket and the old gate failed there while the
// daemon was up and serving. readdir() has no such problem -- it lists the entry
// on both platforms -- so the directory listing is the portable way to ask.
//
// Probing with a connect attempt instead would be the stronger assertion, but a
// connect to a not-yet-bound socket emits an error that bun's test runner
// attributes to the running test even when a listener handles it. Waiting for the
// entry to appear first keeps us from ever connecting into the void; the doctor
// call that follows is the real functional proof that fleetd is answering.
async function waitForFleetdSocket(
  sockPath: string,
  proc: Bun.Subprocess,
  budgetMs = 8000
): Promise<void> {
  const dir = dirname(sockPath);
  const name = basename(sockPath);
  for (let waited = 0; waited < budgetMs; waited += 100) {
    if (readdirSync(dir).includes(name)) return;
    await Bun.sleep(100);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  throw new Error(
    `fleetd socket never appeared at ${sockPath} after ${budgetMs}ms.\n` +
      `--- fleetd stdout ---\n${stdout}\n--- fleetd stderr ---\n${stderr}`
  );
}

// Tears down a spawned fleetd and its temp state dir. Awaiting `exited` is load
// bearing on Windows: kill() only asks, and until the child is really gone it
// still holds the SQLite and socket handles, which makes rmSync throw EBUSY.
async function stopFleetdAndCleanup(proc: Bun.Subprocess, home: string): Promise<void> {
  proc.kill();
  await proc.exited;
  rmSync(home, { recursive: true, force: true });
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

  afterAll(async () => {
    await stopFleetdAndCleanup(fleetdProc, home);
  });

  test("doctor reports 1 registered bot and all fleet tables", async () => {
    const sockPath = join(home, "fleetd.sock");
    await waitForFleetdSocket(sockPath, fleetdProc);

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
    // Above bun's 5s default: spawning the daemon plus the readiness budget can
    // legitimately exceed it on a cold or slow machine.
  }, 20000);
});

// The regression test for the bug as it was actually met: fleetd printed
// "fleetd listening on <path>" and then, in the same process, "Failed to listen at
// <path>" -- and stayed alive, deaf, with its only status message claiming health.
// A daemon nobody can connect to must fail loudly, not quietly.
describe("fleetd when it cannot bind its socket", () => {
  const root = join(import.meta.dir, "..");
  let outer: string;

  afterAll(() => {
    if (outer) rmSync(outer, { recursive: true, force: true });
  });

  test("it reports the failure and exits instead of announcing that it is listening", async () => {
    outer = mkdtempSync(join(tmpdir(), "mirza-bots-e2e-nobind-"));
    // A socket path longer than sockaddr_un's sun_path (108 bytes on Linux and
    // Windows, 104 on macOS) cannot be bound anywhere, which makes this a portable
    // way to force the exact failure -- and it is how the bug surfaced in the first
    // place, from a state dir that simply sat too deep.
    const home = join(outer, "d".repeat(100));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        allowFrom: ["111"],
        bots: { "bot-01": { home: "/tmp/bot-01", token: "fake:token" } },
      })
    );

    const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: root,
      env: { ...process.env, MIRZA_BOTS_HOME: home, TELEGRAM_API_ROOT: "http://127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const outcome = await Promise.race([proc.exited, Bun.sleep(10000).then(() => "hung" as const)]);
    // Killing first so the piped streams close and the reads below can settle.
    if (outcome === "hung") proc.kill();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // Same reason as stopFleetdAndCleanup: afterAll cannot remove the temp dir on
    // Windows until the child has really let go of it.
    await proc.exited;

    // The heart of it: never claim to be listening when the bind did not happen.
    expect(stdout).not.toContain("listening");
    expect(stderr).toContain("cannot listen");
    // Staying alive is the failure mode that hid this for so long.
    expect(outcome).not.toBe("hung");
    expect(outcome).not.toBe(0);
  }, 20000);
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

  afterAll(async () => {
    fake.server.stop(true);
    await stopFleetdAndCleanup(fleetdProc, home);
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
    const { client, lines, pushes } = await connectToFleetd(sockPath);

    client.write(encode({ type: "hello", cwd: "/tmp/bot-01" }));
    await Bun.sleep(100);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, bot: "bot-01" });

    // The offline queue, end to end: "halo bot" was polled while no plugin was
    // connected, so it went to bot_inbox. Connecting drains it onto this very
    // connection. Before drainQueue was wired into the socket server's onBind hook,
    // such messages sat in the database forever and were never delivered to anyone.
    expect(await waitForLines(pushes, 1)).toBeGreaterThanOrEqual(1);
    const drained = JSON.parse(pushes[0]!);
    expect(drained.type).toBe("push_message");
    expect(drained.text).toBe("halo bot");
    expect(drained.meta.chat_id).toBe("111");

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

  afterAll(async () => {
    fake.server.stop(true);
    await stopFleetdAndCleanup(fleetdProc, home);
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
