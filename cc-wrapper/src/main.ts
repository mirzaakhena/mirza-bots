/**
 * Perakitan: hidupkan CC di PTY, pipe dua arah dengan terminal pengguna, awasi
 * folder `pending/`, dan jalankan antrean.
 *
 * Jalankan dengan Node, bukan Bun (Task 0 — lihat PROBE.md):
 *   npx tsx src/main.ts
 *
 * Folder state mengikuti pola wrapper lama supaya penulis yang sudah ada tetap
 * bekerja: <CLAUDE_PROJECT_DIR>/.claude/channels/pty-controller/pending/
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnClaude, runPlan, sleep } from "./pty";
import { InjectionQueue } from "./queue";
import { planCommand, planDurationMs } from "./typer";
import { specFor } from "./registry";
import { parsePayload } from "./inbox";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const STATE_DIR = join(PROJECT_DIR, ".claude", "channels", "pty-controller");
const PENDING_DIR = join(STATE_DIR, "pending");
const QUEUE_POLL_MS = 200;
const INBOX_POLL_MS = 500;

mkdirSync(PENDING_DIR, { recursive: true });

// Semua argumen sesudah nama skrip diteruskan APA ADANYA ke `claude`, jadi
// wrapper bisa dipakai persis seperti memanggil `claude` sendiri:
//   npx tsx src/main.ts --dangerously-skip-permissions
const extraArgs = process.argv.slice(2);

const queue = new InjectionQueue();
const pty = spawnClaude({ cwd: PROJECT_DIR, extraArgs });

// PTY -> terminal pengguna, dan stdin pengguna -> PTY. Tanpa ini wrapper tidak
// terasa seperti menjalankan `claude` biasa, dan itu syarat paling dasar:
// kalau rasanya berbeda, tidak ada yang mau memakainya.
pty.onData((d) => process.stdout.write(d));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => pty.write(chunk.toString("utf8")));
process.stdout.on("resize", () =>
  pty.resize(process.stdout.columns || 100, process.stdout.rows || 30)
);

// Baca folder pending. Polling, bukan fs.watch: liputan event "create" milik
// fs.watch di Windows secara historis tidak bisa diandalkan, dan jalur ini
// harus andal.
setInterval(() => {
  let files: string[];
  try {
    files = readdirSync(PENDING_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.includes(".tmp.")) continue;
    const path = join(PENDING_DIR, f);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // tick lain sudah mengambilnya
    }
    // Hapus lebih dulu supaya crash di tengah penanganan tidak memproses ganda.
    try {
      rmSync(path);
    } catch {
      /* sudah hilang — tidak apa-apa */
    }

    const parsed = parsePayload(raw);
    if (parsed.kind === "invalid") {
      console.error(`[cc-wrapper] payload ditolak (${f}): ${parsed.error}`);
      continue;
    }
    if (parsed.kind === "single") {
      queue.enqueue(parsed.item);
    } else {
      queue.enqueueBatch(randomUUID(), parsed.items);
    }
  }
}, INBOX_POLL_MS);

// Kuras antrean.
let dispatching = false;
setInterval(() => {
  if (dispatching) return;
  const now = Date.now();
  const item = queue.next(now);
  if (!item) return;

  dispatching = true;
  const spec = specFor(item.command);
  const steps = planCommand(item.command, {
    confirmAfterMs: item.confirmAfterMs ?? spec.confirmAfterMs,
  });
  queue.markDispatched(planDurationMs(steps), now);
  void runPlan((s) => pty.write(s), steps, sleep).finally(() => {
    dispatching = false;
  });
}, QUEUE_POLL_MS);

pty.onExit(({ exitCode }) => {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.exit(exitCode ?? 0);
});
