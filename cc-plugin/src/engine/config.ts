import { z } from "zod";
import { readFileSync } from "node:fs";

/**
 * Konfigurasi SATU bot -- bot yang foldernya memuat berkas ini.
 *
 * `bots` sudah tidak ada, dan `strictObject` MENOLAKNYA alih-alih
 * mengabaikannya. Itu disengaja: config lama yang diterima diam-diam akan
 * membuat sebuah folder melayani token yang bukan miliknya, dan kegagalan itu
 * tidak punya gejala sampai dua sesi berebut token yang sama -- persis insiden
 * 2026-08-04 yang membuat enam bot tidak bisa dihubungi berjam-jam.
 */
export const ConfigSchema = z.strictObject({
  token: z.string().min(1),
  allowFrom: z.array(z.string()),
  // IANA zone name (e.g. "Asia/Jakarta"), used only to render ts_local alongside
  // the UTC ts we push. Deliberately NOT validated against the ICU zone list:
  // a typo here should cost the AI its local time, not stop the bot booting.
  timezone: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

/**
 * `path` wajib -- tidak ada nilai default lagi.
 *
 * Default lama menunjuk state root yang sekarang tidak ada. Memaksa pemanggil
 * menyebut folder mana yang ia maksud adalah setengah dari keputusan ini: satu
 * proses melayani satu bot, dan bot itu adalah folder tempat ia berjalan.
 */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${path}: ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    // Buang BOM: berkas ber-BOM sudah menggigit proyek ini tiga kali (SCAR-026),
    // dan config.json adalah berkas yang paling sering disunting tangan.
    json = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    throw new ConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`Config at ${path} failed validation: ${result.error.message}`);
  }
  return result.data;
}
