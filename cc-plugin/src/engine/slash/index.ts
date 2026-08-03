/**
 * Perakitan lapisan slash Telegram.
 *
 * Satu aturan yang mengikat seluruh berkas ini dan tidak boleh dilanggar
 * (spec §2.3): pemanggilnya WAJIB sudah mencatat pesannya ke conversations.db
 * sebelum memanggil fungsi di sini. Sistem lama mencegat sebelum mencatat, dan
 * biayanya nyata -- audit membaca /switch sebagai 0x dipakai padahal 139x.
 */
import { classify } from "./classify";
import { mapKnown } from "./map";
import { writePending, pendingDir } from "./pending";

export type SlashOutcome =
  /** Bukan slash Telegram: teruskan ke sesi AI seperti biasa. */
  | { kind: "passthrough" }
  /** Payload sudah ditulis; `ack` layak dikirim ke user. */
  | { kind: "sent"; ack: string }
  /** Slash dikenal tapi argumennya tidak sah. */
  | { kind: "error"; message: string }
  /** Slash tak dikenal: minta konfirmasi sebelum disuntik. */
  | { kind: "confirm"; command: string; prompt: string };

export type SlashDeps = { projectDir: string; newId: () => string };

export function handleSlash(text: string, deps: SlashDeps): SlashOutcome {
  const c = classify(text);
  if (c.kind === "not-slash") return { kind: "passthrough" };

  if (c.kind === "unknown") {
    return {
      kind: "confirm",
      command: c.command,
      prompt: `Kirim \`${c.command}\` ke Claude Code?`,
    };
  }

  const m = mapKnown(c.name, c.arg);
  if (!m.ok) return { kind: "error", message: m.message };

  writePending(pendingDir(deps.projectDir), m.payload, deps.newId());
  return { kind: "sent", ack: m.ack };
}

/**
 * Dipanggil sesudah user menekan tombol "Kirim". Command diteruskan APA
 * ADANYA -- lapisan ini tidak mengolahnya. Menerapkan pemetaan di sini akan
 * membuat tombol konfirmasi berbohong soal apa yang dikirim.
 */
export function handleConfirm(command: string, deps: SlashDeps): SlashOutcome {
  writePending(pendingDir(deps.projectDir), { command }, deps.newId());
  return { kind: "sent", ack: `📤 \`${command}\` dikirim ke Claude Code` };
}
