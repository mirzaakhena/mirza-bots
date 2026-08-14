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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { spawnClaude, runPlan, sleep } from "./pty";
import { InjectionQueue } from "./queue";
import { planCommand, planDurationMs } from "./typer";
import { specFor } from "./registry";
import { parsePayload, isStalePayload, STALE_PAYLOAD_MS } from "./inbox";
import { describeDispatchFailure } from "./report";
import { acquireWrapperLock, releaseWrapperLock } from "./lock";
import {
  killQuietly,
  parseOwnerPid,
  stepOwnerWatch,
  type OwnerWatchState,
} from "./shutdown";
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
/**
 * Seberapa sering wrapper memeriksa apakah pemiliknya masih ada. Dengan ambang
 * dua kali meleset, terminal yang hilang terdeteksi dalam ~2 detik — cukup
 * cepat untuk tidak meninggalkan sesi yatim, cukup lambat untuk tidak jadi
 * beban.
 */
const OWNER_POLL_MS = 1_000;
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
    closeSession(exitCode ?? 0);
  });
}

/**
 * Satu-satunya jalan keluar. Urutannya penting dan pernah salah:
 *
 * `setRawMode(false)` + `pause()` HARUS dilakukan, bukan kerapian. stdin yang
 * masih raw menahan proses tetap hidup — terukur 2026-08-13: wrapper yang
 * melewatkan langkah ini menjalankan seluruh sisa shutdown-nya (PTY mati, lock
 * terlepas) lalu **tetap tidak keluar**. Gejalanya persis bug yang sedang
 * diperbaiki, jadi mudah salah baca sebagai "watchdog tidak jalan".
 */
function closeSession(code: number): never {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  killQuietly(pty);
  releaseWrapperLock(LOCK_FILE, process.pid);
  process.exit(code);
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
//
// PTY-nya ikut dimatikan, dan itu tambahan 2026-08-13. Sebelumnya jalur mati
// hanya satu arah: "CC keluar -> wrapper ikut keluar" (lihat p.onExit). Arah
// sebaliknya tidak ada, jadi wrapper yang berhenti meninggalkan `claude.exe`
// hidup tanpa siapa pun yang membacanya -- lengkap dengan MCP server-nya.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => closeSession(0));
}
// Jaring terakhir untuk jalan keluar yang tidak lewat closeSession (mis.
// exception yang tidak tertangkap). `process.exit()` sendiri tidak memanggil
// ini dua kali secara berbahaya: kill dan release dua-duanya idempoten.
process.on("exit", () => {
  killQuietly(pty);
  releaseWrapperLock(LOCK_FILE, process.pid);
});

// --- pemilik yang hilang ----------------------------------------------------
// Windows tidak mengirim apa pun ke anak saat induknya mati (diukur; lihat
// src/shutdown.ts). Jadi satu-satunya cara tahu adalah bertanya berkala.
//
// Hanya menyala kalau ada yang MENGAKU memiliki wrapper ini lewat
// CC_WRAPPER_OWNER_PID. Tanpa itu wrapper berperilaku persis seperti dulu:
// bot yang sengaja dilepas dari terminal tidak boleh bunuh diri hanya karena
// tidak ada yang mengaku memilikinya.
const ownerPid = parseOwnerPid(process.env.CC_WRAPPER_OWNER_PID, process.pid);
if (ownerPid !== null) {
  let ownerState: OwnerWatchState = { consecutiveMisses: 0 };
  setInterval(() => {
    let alive: boolean;
    try {
      // Sinyal 0 memeriksa keberadaan tanpa mengirim apa pun -- alat yang sama
      // yang dipakai lock.ts untuk mengenali pemegang lock yang sudah mati.
      process.kill(ownerPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    const r = stepOwnerWatch(ownerState, alive);
    ownerState = r.state;
    if (!r.shutdown) return;
    console.error(
      `[cc-wrapper] pemilik (PID ${ownerPid}) sudah tidak ada — menutup sesi ` +
        `Claude Code di ${BOT_HOME}.`
    );
    closeSession(0);
  }, OWNER_POLL_MS);
}

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
    // Umur berkas dibaca SEBELUM ia dihapus. `mtime` yang tidak terbaca
    // dijawab "sekarang", jadi arah salahnya menjalankan — sama seperti
    // isStalePayload memperlakukan mtime di masa depan.
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      /* berkasnya boleh hilang di antara read dan stat */
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

    // Dibuang SESUDAH di-parse, bukan sebelum: yang dibuang harus bisa
    // DISEBUT. Baris log yang cuma memuat nama berkas menyuruh pembacanya
    // menebak perintah apa yang hilang — pelajaran yang sama dengan
    // describeDispatchFailure.
    if (isStalePayload(mtimeMs, Date.now())) {
      const commands =
        parsed.kind === "single"
          ? parsed.item.command
          : parsed.items.map((i) => i.command).join(", ");
      const menit = Math.round((Date.now() - mtimeMs) / 60_000);
      console.error(
        `[cc-wrapper] payload BASI dibuang (${menit} menit menunggu, batas ` +
          `${STALE_PAYLOAD_MS / 60_000}): ${commands}. Wrapper tidak berjalan saat ` +
          `perintah ini dikirim; menjalankannya sekarang akan mengenai sesi yang salah.`
      );
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
  // `.catch` DAN `.finally`, dan keduanya wajib -- masing-masing menjaga hal
  // yang berbeda. `.finally` menjaga ANTREAN: dispatch yang gagal tidak boleh
  // mengunci `dispatching` selamanya (PTY-063). `.catch` menjaga JEJAKNYA:
  // sebelum 2026-08-07 hanya `.finally` yang ada, jadi antreannya memang
  // selamat -- tapi `pty.write()` yang melempar membuat perintah slash user
  // lenyap TANPA SATU BARIS LOG PUN. Pagar untuk pasangan ini ada di
  // `test/dispatch-failure.test.ts`.
  void runPlan((s) => pty.write(s), steps, sleep)
    .catch((err) => console.error(describeDispatchFailure(item.command, err)))
    .finally(() => {
      dispatching = false;
    });
}, QUEUE_POLL_MS);
