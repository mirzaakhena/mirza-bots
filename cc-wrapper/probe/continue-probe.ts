/**
 * Probe: apa yang terjadi kalau `claude --continue` dijalankan di folder yang
 * belum punya sesi sama sekali? Itu kasus pertama tiap bot baru, jadi kalau CC
 * menolak start, wrapper harus tahu sebelum menulis kodenya.
 */
import { spawn } from "node-pty";

const cwd = process.argv[2] ?? process.cwd();
const extra = process.argv.slice(3);
let captured = "";

const pty = spawn("cmd.exe", ["/c", "claude", ...extra], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd,
  env: (() => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDE_CODE_CHILD_SESSION") continue;
      if (v !== undefined) e[k] = v;
    }
    return e;
  })(),
});

let exited = false;
let exitCode: number | null = null;
pty.onData((d) => { captured += d; });
pty.onExit(({ exitCode: c }) => { exited = true; exitCode = c; });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function strip(s: string): string {
  return s
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B\[[?>!]?[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B[=>NOM]/g, "");
}

async function main(): Promise<void> {
  await sleep(12000);
  const out = strip(captured).replace(/\s+/g, " ").trim();
  console.log(`cwd        : ${cwd}`);
  console.log(`args       : claude ${extra.join(" ")}`);
  console.log(`keluar?    : ${exited ? `YA (code=${exitCode})` : "TIDAK (masih hidup)"}`);
  console.log(`byte       : ${captured.length}`);
  console.log(`cuplikan   : ${out.slice(0, 400)}`);
  if (!exited) pty.kill();
  await sleep(400);
  process.exit(0);
}
main();
