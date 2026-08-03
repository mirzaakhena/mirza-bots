/**
 * Memasang bridge sebagai `statusLine` project -- atau MENOLAK memasangnya.
 *
 * Syarat yang mengatasi segalanya (spec §1): statusline milik user harus tetap
 * hidup. Kalau harus memilih, /context yang mengalah.
 *
 * Sistem lama juga BERNIAT meneruskan ke statusline pendahulu -- kodenya ada.
 * Yang tidak ada adalah satu pun langkah yang MEMERIKSA apakah niat itu
 * tercapai, jadi kegagalannya senyap dan bertahan di enam dari enam bot.
 * Tiga pagar di berkas ini semuanya ada untuk membuat kegagalan yang sama
 * berisik:
 *
 *   Pagar 1 (chain.ts) -- lihat DUA lapisan settings, bukan satu
 *   Pagar 2 -- tulis, lalu BACA ULANG; tidak cocok berarti rollback
 *   Pagar 3 -- kalau tidak yakin apa yang terpasang, JANGAN memasang
 *
 * Pagar 3 adalah pembalikan langsung terhadap kesalahan lama, yang
 * memperlakukan "aku tidak menemukannya" sebagai "memang tidak ada".
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveChain } from "./chain";

export type InstallDeps = {
  projectDir: string;
  userSettingsPath: string;
  bridgeCommand: string;
  chainPath: string;
  /**
   * Disuntik test untuk memaksa kegagalan penulisan. Di produksi selalu
   * `writeFileSync`. Ada karena rollback hanya bisa dibuktikan kalau
   * penulisannya benar-benar bisa gagal -- dan di Windows itu bukan hipotetis:
   * antivirus dan indexer sesekali mengunci berkas yang baru dibuat.
   */
  writeFile?: (path: string, data: string) => void;
};

/**
 * Perintah yang dipasang sebagai `statusLine.command`. Murni.
 *
 * Selalu forward slash: nilai ini masuk ke JSON, dan backslash Windows di
 * dalam JSON menuntut escape ganda yang gampang salah -- Claude Code menerima
 * forward slash di Windows tanpa keluhan.
 *
 * Bentuknya harus STABIL antar-pemanggilan: `resolveChain` membandingkannya
 * apa adanya untuk tahu apakah bridge sudah terpasang, jadi perintah yang
 * berubah-ubah akan membuat bridge dipasang di atas dirinya sendiri.
 */
export function buildBridgeCommand(pluginRoot: string): string {
  const p = `${pluginRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/bin/statusline-bridge.ts`;
  return `bun run "${p}"`;
}

/**
 * Akar folder plugin. Murni: kedua sumbernya dilewatkan pemanggil.
 *
 * `CLAUDE_PLUGIN_ROOT` diisi Claude Code saat menjalankan hook, tapi BELUM
 * diukur apakah ia juga ada saat MCP server dijalankan -- jadi cadangannya
 * bukan kemewahan. Cadangan itu menurunkan letak plugin dari URL modul engine
 * sendiri: `<root>/src/engine/engine.ts` -> `<root>`.
 *
 * Sengaja memakai `import.meta.url` (standar) dan bukan `import.meta.dir`
 * (khusus Bun, tidak punya tipe) -- pemeriksaan tsc menolak yang kedua.
 */
export function pluginRootFrom(envRoot: string | undefined, engineModuleUrl: string): string {
  const fromEnv = envRoot?.trim();
  if (fromEnv) return fromEnv;
  // file:///C:/x/y/src/engine/engine.ts -> /C:/x/y/src/engine/ -> C:/x/y
  const dir = decodeURIComponent(new URL(".", engineModuleUrl).pathname);
  return dir
    .replace(/^\/([A-Za-z]:)/, "$1")
    .replace(/\/+$/, "")
    .replace(/\/src\/engine$/, "");
}

export type InstallResult =
  | { kind: "installed"; chained: string | null }
  | { kind: "already-installed" }
  | { kind: "refused"; reason: string }
  | { kind: "rolled-back"; reason: string };

type ReadResult =
  | { ok: true; value: Record<string, unknown>; existed: boolean }
  | { ok: false };

function readSettings(path: string): ReadResult {
  // Belum ada berkasnya adalah keadaan SAH -- itu beda dari "ada tapi tidak
  // bisa dibaca", dan membedakan keduanya justru inti pagar 3.
  if (!existsSync(path)) return { ok: true, value: {}, existed: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown>, existed: true };
  } catch {
    return { ok: false };
  }
}

export function installBridge(deps: InstallDeps): InstallResult {
  const write = deps.writeFile ?? ((p: string, d: string) => writeFileSync(p, d));
  const projectSettingsPath = join(deps.projectDir, ".claude", "settings.json");

  const project = readSettings(projectSettingsPath);
  const user = readSettings(deps.userSettingsPath);

  // PAGAR 3. Settings yang tidak terbaca berarti kita TIDAK TAHU apa yang
  // sedang terpasang, dan memasang di atas ketidaktahuan persis yang menggusur
  // statusline user di sistem lama.
  if (!project.ok) {
    return { kind: "refused", reason: `${projectSettingsPath} tidak bisa dibaca -- tidak memasang apa pun` };
  }
  if (!user.ok) {
    return { kind: "refused", reason: `${deps.userSettingsPath} tidak bisa dibaca -- tidak memasang apa pun` };
  }

  const chain = resolveChain(project.value.statusLine, user.value.statusLine, deps.bridgeCommand);
  if (chain.kind === "already-bridge") return { kind: "already-installed" };

  const chained = chain.kind === "found" ? chain.command : null;

  // Rantai dulu, settings belakangan. Urutannya disengaja: kegagalan yang
  // paling mungkin terjadi jadi tidak pernah meninggalkan sistem dalam keadaan
  // "bridge terpasang tapi rantainya hilang" -- yaitu keadaan sistem lama.
  try {
    mkdirSync(dirname(deps.chainPath), { recursive: true });
    write(deps.chainPath, chained ?? "");

    // PAGAR 2: baca ULANG. Menulis tanpa memeriksa adalah niat, bukan jaminan.
    const written = readFileSync(deps.chainPath, "utf8");
    if (written !== (chained ?? "")) {
      throw new Error(`rantai tersimpan "${written}", seharusnya "${chained ?? ""}"`);
    }
  } catch (err) {
    return { kind: "rolled-back", reason: `gagal menyimpan rantai: ${(err as Error).message}` };
  }

  const before = project.existed ? readFileSync(projectSettingsPath, "utf8") : null;

  try {
    mkdirSync(dirname(projectSettingsPath), { recursive: true });
    write(
      projectSettingsPath,
      JSON.stringify(
        { ...project.value, statusLine: { type: "command", command: deps.bridgeCommand } },
        null,
        2
      ) + "\n"
    );
  } catch (err) {
    // Rollback. Berkas yang tadinya tidak ada HARUS hilang lagi -- meninggalkan
    // settings setengah jadi berarti project punya statusLine yang bukan apa
    // pun, dan itu menggusur punya user: persis kegagalan yang dicegah.
    try {
      if (before !== null) writeFileSync(projectSettingsPath, before);
      else if (existsSync(projectSettingsPath)) rmSync(projectSettingsPath);
    } catch {
      // Rollback yang ikut gagal tidak boleh menutupi sebab aslinya.
    }
    return { kind: "rolled-back", reason: `gagal menulis settings: ${(err as Error).message}` };
  }

  return { kind: "installed", chained };
}
