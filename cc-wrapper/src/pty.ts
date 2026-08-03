/**
 * Satu-satunya berkas yang menyentuh terminal. Sengaja setipis mungkin: apa pun
 * yang bisa diputuskan tanpa terminal sudah diputuskan di modul murni.
 *
 * Berkas ini berjalan di Node, bukan Bun — Task 0 mengukur bahwa `pty.write()`
 * gagal di Bun 1.3.11 dengan ERR_SOCKET_CLOSED sementara Node v22 bekerja.
 * Lihat cc-wrapper/PROBE.md.
 */
import { spawn, type IPty } from "node-pty";
import type { WriteStep } from "./typer";

/**
 * Jalankan sebuah rencana pengetikan. `write` dan `sleep` diserahkan dari luar
 * supaya fungsinya bisa diuji tanpa PTY dan tanpa timer sungguhan.
 */
export async function runPlan(
  write: (s: string) => void,
  steps: WriteStep[],
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  for (const step of steps) {
    write(step.text);
    await sleep(step.delayAfterMs);
  }
}

/**
 * Environment untuk sesi CC anak.
 *
 * `CLAUDE_CODE_CHILD_SESSION` HARUS dibuang. Task 0 menemukan bahwa sesi anak
 * mewarisinya dan akibatnya MEMATIKAN penyimpanan transcript — padahal berkas
 * sesi .jsonl adalah salah satu sumber bukti yang dipakai post-check. Wrapper
 * yang dijalankan dari dalam sesi CC lain akan diam-diam kehilangan seluruh
 * mekanisme post-check-nya, dan gejalanya terbaca sebagai "post-check bug"
 * alih-alih "environment kotor".
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "CLAUDE_CODE_CHILD_SESSION") continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Susun shell + argumen untuk menghidupkan CC.
 *
 * Di Windows `claude` adalah shim .cmd yang butuh cmd.exe untuk diresolusi.
 * ConPTY biasanya menyerahkannya ke shell sendiri, tapi menyebutkannya
 * eksplisit lebih bisa diandalkan.
 *
 * `extraArgs` diteruskan APA ADANYA. Wrapper tidak berpendapat soal flag CC,
 * sama seperti ia tidak berpendapat soal command mana yang boleh disuntik —
 * kebijakan itu milik lapisan atas. User menjalankan CC dengan flag sendiri
 * (mis. --dangerously-skip-permissions,
 * --dangerously-load-development-channels), dan wrapper yang tidak bisa
 * meneruskannya berarti wrapper yang tidak bisa dipakai.
 *
 * Murni supaya bisa diuji untuk kedua platform tanpa menjalankan keduanya.
 */
export function buildSpawnArgs(
  bin: string,
  extraArgs: string[],
  isWindows: boolean
): { shell: string; args: string[] } {
  return isWindows
    ? { shell: "cmd.exe", args: ["/c", bin, ...extraArgs] }
    : { shell: bin, args: [...extraArgs] };
}

/** Hidupkan Claude Code di dalam PTY. */
export function spawnClaude(opts?: {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Flag yang diteruskan ke `claude` apa adanya. */
  extraArgs?: string[];
}): IPty {
  const isWindows = process.platform === "win32";
  const bin = process.env.CLAUDE_BIN ?? "claude";
  const { shell, args } = buildSpawnArgs(bin, opts?.extraArgs ?? [], isWindows);
  return spawn(shell, args, {
    name: "xterm-256color",
    cols: opts?.cols ?? process.stdout.columns ?? 100,
    rows: opts?.rows ?? process.stdout.rows ?? 30,
    cwd: opts?.cwd ?? process.cwd(),
    env: childEnv(),
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
