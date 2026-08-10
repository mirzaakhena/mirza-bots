import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startEngine } from "./engine/engine";
import { buildServer } from "./server";
import { installShutdown } from "./engine/shutdown";

// Claude Code sets CLAUDE_PROJECT_DIR for MCP servers precisely so they can
// resolve the session's project directory without depending on the process's
// working directory (which an MCP stdio server does not control and isn't
// guaranteed to match the session's project). Prefer it; fall back to
// process.cwd() for any host that doesn't set it (e.g. manual/local testing).
export function resolveIdentityCwd(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function main(): Promise<void> {
  const botHome = resolveIdentityCwd();
  const started = startEngine(botHome);

  if (!started.ok) {
    // Deliberately NOT an exit. A plugin that dies here is indistinguishable
    // from a plugin that was never installed -- which is exactly what cost two
    // hours on 2026-08-01 (W-16) and left nothing behind to diagnose, because a
    // process that dies before it can speak leaves no evidence. Serve the tools
    // anyway, so the reason reaches whoever calls one.
    //
    // botHome diteruskan di cabang ini juga: tool send_slash (Task 5) harus
    // tetap bisa memulihkan sesi user lewat /clear atau /rename justru saat
    // engine gagal start -- di situlah paling dibutuhkan.
    console.error(`cc-plugin: ${started.message}`);
    const server = buildServer({ kind: "unavailable", reason: started.message }, botHome);
    await server.connect(new StdioServerTransport());
    return;
  }

  console.error(`cc-plugin: engine running for bot "${started.engine.bot}"`);

  // Sebelum 0.41.0 tidak ada baris ini, dan `Engine.close()` karena itu tidak
  // pernah berjalan sama sekali di produksi -- seluruh pembersihnya
  // (`releaseBotLock`, pemindai inbox, keepalive typing, pemantau nama sesi)
  // adalah kode mati, dan `bot.pid` tertinggal basi tiap kali sesi ditutup.
  // Aturan-aturannya ada di engine/shutdown.ts, di mana ia bisa diuji.
  installShutdown({
    close: () => started.engine.close(),
    on: (event, handler) => {
      process.on(event as NodeJS.Signals, handler);
    },
    exit: (code) => process.exit(code),
    onError: (err) => console.error(`cc-plugin: gagal menutup engine dengan rapi: ${err}`),
  });

  const server = buildServer(started.engine, botHome);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`cc-plugin: fatal startup error: ${err}`);
    process.exit(1);
  });
}
