/**
 * Probe lanjutan: folder yang belum dipercaya memunculkan gerbang
 * "Quick safety check" SEBELUM CC siap. Dua pertanyaan sekaligus:
 *   1. Bisakah gerbang itu dilewati dengan injeksi Enter?
 *   2. Sesudahnya, apa yang `--continue` lakukan di folder tanpa sesi?
 */
import { spawn } from "node-pty";

const cwd = process.argv[2] ?? process.cwd();
const extra = process.argv.slice(3);
let captured = "";

const pty = spawn("cmd.exe", ["/c", "claude", ...extra], {
  name: "xterm-256color", cols: 100, rows: 30, cwd,
  env: (() => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDE_CODE_CHILD_SESSION") continue;
      if (v !== undefined) e[k] = v;
    }
    return e;
  })(),
});

pty.onData((d) => { captured += d; });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const strip = (s: string) => s
  .replace(/\x1B\][^\x07]*\x07/g, "")
  .replace(/\x1B\[[?>!]?[0-9;]*[A-Za-z]/g, "")
  .replace(/\x1B[=>NOM]/g, "");

async function main(): Promise<void> {
  await sleep(10000);
  const sebelum = strip(captured).replace(/\s+/g, " ").trim();
  console.log(`--- SEBELUM Enter (${captured.length} byte) ---`);
  console.log(sebelum.slice(0, 200));

  console.log(`\n>>> kirim Enter`);
  pty.write("\r");
  await sleep(8000);

  const sesudah = strip(captured).replace(/\s+/g, " ").trim();
  console.log(`--- SESUDAH Enter (${captured.length} byte) ---`);
  console.log(sesudah.slice(-700));
  pty.kill();
  await sleep(400);
  process.exit(0);
}
main();
