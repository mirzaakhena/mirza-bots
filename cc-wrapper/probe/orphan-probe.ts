/**
 * Probe: apa yang DITERIMA sebuah proses Node saat induknya hilang?
 *
 * Pertanyaannya lahir dari bug nyata (2026-08-13): terminal crash, tapi seluruh
 * pohon `mirza-bot` — wrapper, `claude.exe`, MCP server-nya — jalan terus.
 * Sebelum menulis penawarnya, satu hal harus diukur: apakah ada SINYAL yang
 * bisa didengarkan, atau memang tidak ada apa-apa?
 *
 * Jalankan lewat pengorkestrasi di PROBE.md §Probe ketiga — probe ini sendiri
 * hanya mencatat; yang membunuh induknya ada di luar.
 *
 *   npx tsx probe/orphan-probe.ts <path-berkas-log>
 */
import { appendFileSync } from "node:fs";

const LOG = process.argv[2];
if (!LOG) {
  console.error("pakai: npx tsx probe/orphan-probe.ts <path-berkas-log>");
  process.exit(2);
}

const log = (m: string): void =>
  appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

log(`start pid=${process.pid} ppid=${process.ppid} tty=${process.stdin.isTTY}`);

try {
  process.stdin.setRawMode?.(true);
  log("setRawMode(true) ok");
} catch (e) {
  log(`setRawMode gagal: ${(e as Error).message}`);
}
process.stdin.resume();

// Kalau salah satu dari ini pernah menyala, "dengarkan stdin" adalah jawaban
// yang sah. Kalau tidak pernah, jawaban itu mati dan jangan dicoba lagi.
for (const ev of ["end", "close", "error", "pause"] as const) {
  process.stdin.on(ev, (a?: Error) => log(`STDIN EVENT: ${ev} ${a?.message ?? ""}`));
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  try {
    process.on(sig, () => log(`SIGNAL: ${sig}`));
  } catch (e) {
    log(`pasang ${sig} gagal: ${(e as Error).message}`);
  }
}
process.on("exit", (c) => log(`EXIT code=${c}`));

let n = 0;
const t = setInterval(() => {
  n++;
  let ppidAlive: string;
  try {
    // Sinyal 0: memeriksa keberadaan tanpa mengirim apa pun.
    process.kill(process.ppid, 0);
    ppidAlive = "hidup";
  } catch {
    ppidAlive = "MATI";
  }
  log(`alive tick=${n} ppid(${process.ppid})=${ppidAlive}`);
  if (n >= 24) {
    clearInterval(t);
    log("selesai tanpa pernah menerima EOF");
    process.exit(0);
  }
}, 500);
