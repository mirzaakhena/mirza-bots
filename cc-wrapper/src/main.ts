/**
 * Perakitan: hidupkan CC di PTY, pipe dua arah dengan terminal pengguna, awasi
 * folder `slash/`, dan jalankan antrean.
 *
 * Jalankan dengan Node, bukan Bun (Task 0 — lihat PROBE.md):
 *   npx tsx src/main.ts [flag-flag untuk claude]
 *
 * State tinggal di folder bot itu sendiri, sejajar config.json dan inbox/:
 *   <botHome>/slash/        perintah untuk sesi ini, ditulis cc-plugin
 *   <botHome>/wrapper.pid   satu wrapper per folder
 *
 * SENGAJA bukan folder yang sama dengan inbox/. Loop scan di bawah MENGHAPUS
 * berkas sebelum mem-parse-nya; kalau kedua payload berbagi folder, wrapper
 * menghapus pesan antar-bot lalu menolaknya, dan pesannya lenyap tanpa gejala.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { spawnClaude, runPlan, sleep } from "./pty";
import { InjectionQueue } from "./queue";
import { planCommand, planDurationMs } from "./typer";
import { specFor } from "./registry";
import { parsePayload } from "./inbox";
import { acquireWrapperLock, releaseWrapperLock } from "./lock";
import {
  firstAttemptArgs,
  retryArgs,
  looksLikeTrustGate,
  shouldRetryWithoutContinue,
} from "./startup";

const BOT_HOME = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const SLASH_DIR = join(BOT_HOME, "slash");
const LOCK_FILE = join(BOT_HOME, "wrapper.pid");
const QUEUE_POLL_MS = 200;
const INBOX_POLL_MS = 500;
/** Sebanyak ini keluaran awal disimpan untuk mengenali gerbang trust. */
const BOOT_SNIFF_BYTES = 8_000;

// Semua argumen sesudah nama skrip diteruskan APA ADANYA ke `claude`, jadi
// wrapper bisa dipakai persis seperti memanggil `claude` sendiri.
const extraArgs = process.argv.slice(2);

mkdirSync(SLASH_DIR, { recursive: true });

// --- satu wrapper per folder ------------------------------------------------
const lock = acquireWrapperLock(LOCK_FILE, process.pid);
if (!lock.ok) {
  console.error(
    `cc-wrapper sudah berjalan untuk folder ini (PID ${lock.heldBy}).\n` +
      `  folder: ${BOT_HOME}\n` +
      `Satu folder hanya boleh punya satu wrapper — menutup yang lama akan\n` +
      `membuang sesi Claude Code yang sedang berjalan di dalamnya.`
  );
  process.exit(1);
}

const queue = new InjectionQueue();

// --- menghidupkan CC --------------------------------------------------------
let pty: IPty;
let bootOutput = "";
let bootAt = 0;
let trustGateReported = false;
let retried = false;

function attach(p: IPty): void {
  p.onData((d) => {
    process.stdout.write(d);
    if (bootOutput.length < BOOT_SNIFF_BYTES) {
      bootOutput += d;
      // Gerbang trust muncul SEBELUM CC siap dan menahannya di sana. Wrapper
      // hanya melapor: menyuntik Enter berarti memercayai folder atas nama
      // user tanpa ia melihat isinya (keputusan user 2026-08-03).
      if (!trustGateReported && looksLikeTrustGate(bootOutput)) {
        trustGateReported = true;
        console.error(
          `\n[cc-wrapper] Claude Code berhenti di gerbang kepercayaan folder.\n` +
            `  folder: ${BOT_HOME}\n` +
            `  Sesi ini TIDAK akan siap sampai gerbangnya dijawab, dan perintah\n` +
            `  yang disuntik selama itu akan hilang. Jawab sekali dari keyboard,\n` +
            `  atau buka folder ini dengan \`claude\` manual satu kali.\n`
        );
      }
    }
  });

  p.onExit(({ exitCode }) => {
    const elapsedMs = Date.now() - bootAt;
    // `--continue` di folder tanpa sesi menjawab "No conversation found to
    // continue" lalu keluar (diukur 2026-08-03). Itu keadaan pertama setiap
    // bot baru, jadi dijawab dengan satu spawn ulang tanpa flag itu -- bukan
    // dengan mengintip folder sesi internal CC.
    if (!retried && shouldRetryWithoutContinue({ exited: true, elapsedMs, output: bootOutput })) {
      retried = true;
      console.error(
        `[cc-wrapper] belum ada percakapan di folder ini — memulai sesi baru.`
      );
      start(retryArgs(extraArgs));
      return;
    }
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    releaseWrapperLock(LOCK_FILE, process.pid);
    process.exit(exitCode ?? 0);
  });
}

function start(args: string[]): void {
  bootOutput = "";
  bootAt = Date.now();
  pty = spawnClaude({ cwd: BOT_HOME, extraArgs: args });
  attach(pty);
}

start(firstAttemptArgs(extraArgs));

// stdin pengguna -> PTY. Dipasang sekali; `pty` bisa berganti kalau kita
// spawn ulang, jadi handler-nya membaca variabelnya saat dipanggil.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => pty.write(chunk.toString("utf8")));
process.stdout.on("resize", () =>
  pty.resize(process.stdout.columns || 100, process.stdout.rows || 30)
);

// Lock harus terlepas juga saat wrapper dimatikan dari luar, bukan hanya saat
// CC keluar sendiri -- kalau tidak, Ctrl+C meninggalkan folder terkunci.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    releaseWrapperLock(LOCK_FILE, process.pid);
    process.exit(0);
  });
}
process.on("exit", () => releaseWrapperLock(LOCK_FILE, process.pid));

// --- membaca folder slash ---------------------------------------------------
// Polling, bukan fs.watch: liputan event "create" milik fs.watch di Windows
// secara historis tidak bisa diandalkan, dan jalur ini harus andal.
setInterval(() => {
  let files: string[];
  try {
    files = readdirSync(SLASH_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.includes(".tmp.")) continue;
    const path = join(SLASH_DIR, f);
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

// --- menguras antrean -------------------------------------------------------
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
