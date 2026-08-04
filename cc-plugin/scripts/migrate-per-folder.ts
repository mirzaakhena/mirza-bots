#!/usr/bin/env bun
/**
 * Memindahkan state satu bot dari `~/.claude/mirza-bots` ke folder bot itu.
 *
 * ⚠️ JANGAN DIJALANKAN OTOMATIS. Default-nya DRY-RUN: tanpa `--apply` ia hanya
 * mencetak rencananya. Tidak ada mode apa pun yang MENGHAPUS -- state lama
 * selalu ditinggalkan utuh, dan userlah yang menghapusnya kalau sudah yakin.
 * Yang dipindahkan di sini adalah satu-satunya riwayat percakapan yang ada;
 * migrasi yang menghapus tidak punya jalan mundur.
 *
 * Pemakaian:
 *   bun run scripts/migrate-per-folder.ts <stateRoot> <botHome> <botName>
 *   bun run scripts/migrate-per-folder.ts <stateRoot> <botHome> <botName> --apply
 *
 * Bentuk lama -> bentuk baru:
 *   config.json (bots[<nama>].token + allowFrom + timezone) -> config.json
 *   conversations.db                                        -> conversations.db
 *   sessions/<nama>.id                                      -> session.id
 *   status/<nama>.json                                      -> status.json
 *   status/chained-statusline                               -> chained-statusline
 *   locks/<nama>.pid                                        -> bot.pid
 *   inbox/<nama>/*                                          -> data/*
 *   logs/*                                                  -> logs/*
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type MigrationPlan = {
  copies: Array<{ from: string; to: string }>;
  /** Isi config.json baru, sudah jadi -- ditulis applyMigration. */
  newConfig: { path: string; body: string };
  /** SQL yang DICETAK untuk dijalankan user, tidak pernah dieksekusi skrip ini. */
  sqlDeletes: string[];
  warnings: string[];
};

/** Entri di stateRoot yang memang punya tujuan. Sisanya jadi warning. */
const KNOWN_ENTRIES = new Set([
  "config.json",
  "conversations.db",
  "sessions",
  "status",
  "locks",
  "logs",
  "inbox",
]);

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function planMigration(stateRoot: string, botHome: string, botName: string): MigrationPlan {
  const rawConfig = readFileSync(join(stateRoot, "config.json"), "utf8").replace(/^﻿/, "");
  const oldConfig = JSON.parse(rawConfig) as {
    allowFrom?: string[];
    timezone?: string;
    bots?: Record<string, { home?: string; token?: string }>;
  };

  const entry = oldConfig.bots?.[botName];
  if (entry?.token === undefined) {
    // Menolak, bukan menulis config tanpa token: config yang lolos tanpa token
    // membuat bot gagal start dengan pesan yang menunjuk ke tempat yang salah.
    throw new Error(
      `config.json di ${stateRoot} tidak memuat bot bernama "${botName}" dengan token. ` +
        `Yang ada: ${Object.keys(oldConfig.bots ?? {}).join(", ") || "(tidak ada satu pun)"}.`
    );
  }

  const copies: Array<{ from: string; to: string }> = [];
  const push = (from: string, to: string) => {
    // Sumber yang tidak ada dilewati, bukan membuat migrasi gagal: sebuah bot
    // yang belum pernah dipakai tidak punya session.id, dan itu keadaan sah.
    if (existsSync(from)) copies.push({ from, to });
  };

  push(join(stateRoot, "conversations.db"), join(botHome, "conversations.db"));
  push(join(stateRoot, "sessions", `${botName}.id`), join(botHome, "session.id"));
  push(join(stateRoot, "status", `${botName}.json`), join(botHome, "status.json"));
  push(join(stateRoot, "status", "chained-statusline"), join(botHome, "chained-statusline"));
  push(join(stateRoot, "locks", `${botName}.pid`), join(botHome, "bot.pid"));

  for (const f of listFiles(join(stateRoot, "inbox", botName))) {
    push(join(stateRoot, "inbox", botName, f), join(botHome, "data", f));
  }
  for (const f of listFiles(join(stateRoot, "logs"))) {
    push(join(stateRoot, "logs", f), join(botHome, "logs", f));
  }

  const warnings: string[] = [];

  // Verifikasi arah kedua: apa yang ADA di state lama tapi tidak punya tujuan?
  // "Yang baru muncul" tidak pernah membuktikan "yang lama tidak ketinggalan".
  for (const name of readdirSync(stateRoot)) {
    if (!KNOWN_ENTRIES.has(name)) {
      warnings.push(`${join(stateRoot, name)} tidak punya tujuan di bentuk baru -- diabaikan.`);
    }
  }

  // Bot lain butuh panggilan migrasinya sendiri. Diam soal ini persis bentuk
  // kegagalan yang verifikasi dua arah dirancang untuk menangkap.
  for (const other of Object.keys(oldConfig.bots ?? {})) {
    if (other !== botName) {
      warnings.push(
        `bot "${other}" masih ada di config lama dan BELUM dimigrasikan -- ` +
          `jalankan skrip ini sekali lagi untuk foldernya sendiri.`
      );
    }
  }

  const newConfig = {
    path: join(botHome, "config.json"),
    body:
      JSON.stringify(
        {
          token: entry.token,
          allowFrom: oldConfig.allowFrom ?? [],
          ...(oldConfig.timezone !== undefined ? { timezone: oldConfig.timezone } : {}),
        },
        null,
        2
      ) + "\n",
  };

  const sqlDeletes = [
    `-- Baris milik bot LAIN di conversations.db yang baru disalin.`,
    `-- DICETAK, tidak dijalankan: menghapus baris riwayat tidak punya jalan mundur.`,
    `-- Periksa dulu hasilnya, baru jalankan sendiri kalau memang mau.`,
    `SELECT bot, COUNT(*) FROM messages GROUP BY bot;`,
    `DELETE FROM messages WHERE bot <> '${botName}';`,
  ];

  return { copies, newConfig, sqlDeletes, warnings };
}

/**
 * Menyalin. Tidak memindahkan, tidak menghapus, dan aman diulang.
 *
 * Idempotent karena setiap langkahnya menulis isi yang sama ke tempat yang
 * sama -- migrasi yang hanya aman sekali menghukum siapa pun yang berhenti di
 * tengah lalu mengulang, dan berhenti di tengah adalah hal yang wajar terjadi.
 */
export function applyMigration(plan: MigrationPlan): void {
  for (const { from, to } of plan.copies) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  mkdirSync(dirname(plan.newConfig.path), { recursive: true });
  writeFileSync(plan.newConfig.path, plan.newConfig.body, "utf8");
}

function main(): void {
  const [stateRoot, botHome, botName, ...rest] = process.argv.slice(2);
  if (!stateRoot || !botHome || !botName) {
    console.error(
      `Pemakaian: bun run scripts/migrate-per-folder.ts <stateRoot> <botHome> <botName> [--apply]`
    );
    process.exit(2);
  }

  const plan = planMigration(stateRoot, botHome, botName);
  const apply = rest.includes("--apply");

  console.log(apply ? "MENYALIN:" : "RENCANA (dry-run, tidak ada yang ditulis):");
  for (const { from, to } of plan.copies) console.log(`  ${from}\n    -> ${to}`);
  console.log(`  config baru -> ${plan.newConfig.path}`);
  console.log(plan.newConfig.body.replace(/^/gm, "    "));

  if (plan.warnings.length > 0) {
    console.log("\nPERINGATAN:");
    for (const w of plan.warnings) console.log(`  - ${w}`);
  }

  console.log("\nSQL untuk dijalankan SENDIRI setelah memeriksa hasilnya:");
  for (const line of plan.sqlDeletes) console.log(`  ${line}`);

  if (!apply) {
    console.log("\nTidak ada yang ditulis. Tambahkan --apply untuk menyalin.");
    return;
  }

  applyMigration(plan);
  console.log("\nSelesai menyalin. State lama SENGAJA dibiarkan utuh -- hapus sendiri");
  console.log("kalau bot barunya sudah terbukti jalan.");
}

if (import.meta.main) main();
