import { botNameFrom, configPathIn } from "./paths";

export type IdentityResult = { ok: true; bot: string } | { ok: false; message: string };

/**
 * Answers "which bot am I?" from the folder this session runs in.
 *
 * Dulu pertanyaan ini dijawab dengan mencocokkan cwd ke setiap `home` di
 * `config.bots`. Sekarang cwd ADALAH botnya, dan satu-satunya syarat adalah
 * folder itu memuat `config.json` -- syarat yang sama yang membuat sebuah
 * folder tetangga bisa dikenali sebagai tujuan pesan antar-bot. Satu aturan,
 * dua pemakaian, jadi keduanya tidak bisa berbeda pendapat soal folder mana
 * yang bot.
 *
 * `hasConfig` dilewatkan pemanggil supaya fungsi ini tetap murni.
 *
 * Returns a sentence rather than null on failure, and that difference IS the fix
 * for W-16. The old path rejected an unknown cwd over the socket, cc-plugin's
 * top-level `await connect()` threw, the process exited, and nothing reached the
 * user at all -- the plugin was simply not there. Roughly two hours went into
 * chasing that on 2026-08-01, and the root cause was never found, because a
 * process that dies before it can speak leaves nothing to find.
 *
 * The message names the fix, not just the fault: a refusal that does not teach
 * the correct alternative gets answered with the same wrong attempt.
 */
export function identifyBot(botHome: string, hasConfig: boolean): IdentityResult {
  if (hasConfig) return { ok: true, bot: botNameFrom(botHome) };

  return {
    ok: false,
    message:
      `Folder ini (${botHome}) tidak memuat config.json, jadi sesi ini tidak punya ` +
      `identitas Telegram dan tidak akan polling. Sebuah folder menjadi bot dengan ` +
      `memuat ${configPathIn(botHome)} berisi {"token": "...", "allowFrom": ["..."]}. ` +
      `Buat berkas itu, lalu restart sesi.`,
  };
}
