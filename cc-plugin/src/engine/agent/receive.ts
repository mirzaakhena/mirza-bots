/**
 * Memindai inbox milik bot ini sendiri dan mendorong isinya ke sesi AI.
 *
 * POLLING, bukan fs.watch: liputan event "create" milik fs.watch di Windows
 * secara historis tidak bisa diandalkan, dan jalur ini harus andal. Pola yang
 * sama sudah berjalan di cc-wrapper untuk `pending/`.
 *
 * BERKAS DIHAPUS SEBELUM DIPROSES, supaya crash di tengah penanganan tidak
 * memprosesnya dua kali -- juga dari cc-wrapper. Berkas `.tmp` dan non-JSON
 * dilewati tanpa disentuh: yang pertama milik proses lain yang sedang menulis,
 * yang kedua bukan urusan jalur ini.
 *
 * `meta.origin` adalah SYARAT, bukan fitur. Tanpanya `reply-guard` membaca
 * pesan antar-bot sebagai pesan Telegram yang belum dijawab dan menuntut
 * `reply` ke chat user -- pengulangan W-14, dan chat user disemprot setiap kali
 * dua bot berbicara. Prinsipnya: urusan antar-bot diam di jalurnya sendiri,
 * naik ke Telegram hanya kalau butuh keputusan manusia.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inboxDirIn } from "../paths";
import type { MessageSink } from "../sink";
import { parseAgentMessage } from "./payload";

/** Nilai `meta.origin` untuk pesan yang datang dari bot lain. */
export const AGENT_ORIGIN = "agent";

export const DEFAULT_SCAN_MS = 500;

export function drainInbox(
  botHome: string,
  sink: MessageSink,
  onReject?: (file: string, error: string) => void
): number {
  const dir = inboxDirIn(botHome);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    // Belum ada inbox: bukan kesalahan, cuma belum ada yang menitip.
    return 0;
  }

  let delivered = 0;
  for (const f of files) {
    if (!f.endsWith(".json") || f.includes(".tmp.")) continue;

    const path = join(dir, f);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // tick lain sudah mengambilnya
    }
    try {
      rmSync(path);
    } catch {
      /* sudah hilang -- tidak apa-apa */
    }

    const parsed = parseAgentMessage(raw);
    if (!parsed.ok) {
      onReject?.(f, parsed.error);
      continue;
    }

    const msg = parsed.msg;
    const sessionId = sink.sessionId();
    sink.push({
      type: "push_message",
      text: msg.text,
      // Semua nilai STRING. SCAR-056: meta Claude Code bertipe
      // Record<string,string> ketat, dan satu nilai non-string membuat SELURUH
      // notifikasi dijatuhkan tanpa error muncul di mana pun.
      meta: {
        origin: AGENT_ORIGIN,
        from_bot: msg.from,
        agent_message_id: msg.id,
        ts: msg.ts,
        expects_reply: String(msg.expects_reply),
        hop_count: String(msg.hop_count),
        ...(msg.in_reply_to !== undefined ? { in_reply_to: msg.in_reply_to } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      },
    });
    delivered++;
  }

  return delivered;
}

/**
 * Menyalakan pemindai berkala. Mengembalikan fungsi penghenti.
 *
 * Payload yang ditolak dicatat ke stderr dan bukan didiamkan: sebuah pesan yang
 * tidak pernah sampai dan tidak meninggalkan jejak apa pun adalah bentuk
 * kegagalan yang paling mahal di proyek ini.
 */
export function startInboxScanner(
  botHome: string,
  sink: MessageSink,
  intervalMs: number = DEFAULT_SCAN_MS
): () => void {
  const timer = setInterval(() => {
    drainInbox(botHome, sink, (file, error) =>
      console.error(`cc-plugin: payload inbox ditolak (${file}): ${error}`)
    );
  }, intervalMs);

  // unref supaya pemindai tidak menahan proses tetap hidup sendirian.
  timer.unref?.();

  return () => clearInterval(timer);
}
