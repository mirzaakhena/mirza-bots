/**
 * Probe, bukan kode produk: membuktikan node-pty bisa menghidupkan Claude Code
 * di mesin ini dan menerima satu slash command. Dibuang setelah Task 0 selesai
 * kalau tidak lagi berguna.
 *
 * Catatan penyimpangan dari rencana: keluaran PTY TIDAK dicerminkan ke stdout.
 * Probe ini dijalankan dari dalam sesi Claude Code lain, dan membanjiri stdout
 * dengan escape sequence TUI membuat hasilnya tidak terbaca. Yang dilaporkan
 * hanya ringkasannya; aliran mentahnya disimpan ke berkas.
 */
import { spawn } from "node-pty";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
// Di Windows `claude` adalah shim .cmd yang butuh cmd.exe untuk diresolusi.
const shell = isWindows ? "cmd.exe" : CLAUDE_BIN;
const args = isWindows ? ["/c", CLAUDE_BIN] : [];

const runtime = process.versions.bun
  ? `bun ${process.versions.bun}`
  : `node ${process.version}`;

console.log(`[probe] runtime=${runtime}`);
console.log(`[probe] platform=${process.platform}`);
console.log(`[probe] spawning ${shell} ${args.join(" ")}`);

let captured = "";
let pty: ReturnType<typeof spawn>;
try {
  pty = spawn(shell, args, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
} catch (err) {
  console.log(`[probe] SPAWN GAGAL: ${err}`);
  process.exit(1);
}

console.log(`[probe] spawn ok, pid=${pty.pid}`);

pty.onData((d) => {
  captured += d;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function strip(s: string): string {
  return s
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B\[[?>!]?[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B[=>NOM]/g, "");
}

async function main(): Promise<void> {
  await sleep(12000); // beri CC waktu boot dan mencapai prompt kosong
  const beforeBytes = captured.length;
  console.log(`[probe] setelah boot: ${beforeBytes} byte tertangkap`);

  console.log(`[probe] >>> menulis '/clear' lalu (250ms) Enter`);
  pty.write("/clear");
  await sleep(250);
  pty.write("\r");
  await sleep(6000);

  const out = strip(captured);
  const tag = `probe-out-${process.versions.bun ? "bun" : "node"}.txt`;
  writeFileSync(join(process.cwd(), tag), out, "utf8");

  console.log(`[probe] total ${captured.length} byte (naik ${captured.length - beforeBytes} sesudah /clear)`);
  console.log(`[probe] '/clear' terlihat di output: ${out.includes("/clear") ? "YA" : "TIDAK"}`);
  console.log(`[probe] aliran bersih disimpan ke ${tag}`);
  pty.kill();
  await sleep(500);
  process.exit(0);
}

main().catch((err) => {
  console.log(`[probe] ERROR: ${err}`);
  try { pty.kill(); } catch {}
  process.exit(1);
});
