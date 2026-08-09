/**
 * Daftar sesi untuk `/switch`. Murni.
 *
 * ## Pembagian peran dengan `/branch`
 *
 * `/branch` menjawab "saya di mana, dan cabang apa saja yang serumpun" — ia
 * menggambar SATU silsilah. `/switch` menjawab "bawa saya ke sesi lain" — ia
 * datar, lintas rumpun, tanpa hierarki.
 *
 * Keduanya sengaja tidak saling menyalin: hierarki di dua tempat berarti dua
 * penggambar yang bisa berbeda pendapat, dan bedanya baru ketahuan saat user
 * melihat pohon yang tidak sama di dua perintah.
 *
 * ## Kenapa datar, bukan dikelompokkan per rumpun
 *
 * Satu tombol harus berarti satu sesi yang namanya terlihat. Kalau tombolnya
 * mewakili sebuah rumpun, tap-nya harus MENEBAK sesi mana di dalam rumpun itu
 * yang dimaksud — dan tombol yang menebak lebih buruk daripada daftar yang
 * sedikit lebih panjang.
 *
 * Yang tetap dibawa dari hierarki cuma satu tanda: sesi yang punya cabang
 * diberi `⑂`, supaya user tahu di mana `/branch` akan memperlihatkan lebih
 * banyak.
 */
import type { SessionInfo } from "../sessions";
import { labelOf, shortAge } from "./branch-tree";

/**
 * Sesi yang ditampilkan. Delapan karena itu batas satu baris tombol Telegram:
 * daftar yang lebih panjang dari tombolnya akan memuat baris yang tidak bisa
 * ditap, dan baris seperti itu terbaca sebagai kerusakan.
 */
export const MAX_SWITCH_SESSIONS = 8;

export type SwitchView = {
  text: string;
  /** Urutan yang sama dengan nomor di teks — tombol lahir dari sini. */
  ordered: SessionInfo[];
};

export function renderSwitchList(
  sessions: SessionInfo[],
  currentId: string | undefined,
  now: number
): SwitchView {
  if (sessions.length === 0) {
    return { text: "Belum ada sesi yang tercatat.", ordered: [] };
  }

  const shown = sessions.slice(0, MAX_SWITCH_SESSIONS);
  const hidden = sessions.length - shown.length;

  // Punya cabang dihitung dari SELURUH daftar, bukan dari yang tampil: cabang
  // yang lahir lama tetap membuat induknya bercabang, dan menandainya "tidak
  // punya cabang" hanya karena anaknya di luar delapan teratas adalah bohong.
  const hasChild = new Set<string>();
  for (const s of sessions) {
    const p = s.forkedFrom?.sessionId;
    if (p) hasChild.add(p);
  }

  const counts = new Map<string, number>();
  for (const s of shown) counts.set(labelOf(s), (counts.get(labelOf(s)) ?? 0) + 1);

  const lines = shown.map((s, i) => {
    const label = labelOf(s);
    // Sama seperti di pohon: id pendek hanya untuk yang kembar, supaya nama
    // yang unik tetap bersih.
    const disambig = (counts.get(label) ?? 0) > 1 ? ` (${s.id.slice(0, 8)})` : "";
    const fork = hasChild.has(s.id) ? " ⑂" : "";
    const here = s.id === currentId ? " ← sekarang" : "";
    return `${i + 1}. ${label}${disambig} · ${shortAge(s.mtime, now)}${fork}${here}`;
  });

  const text = [
    ...lines,
    ...(hidden > 0 ? [`(${hidden} sesi lebih lama tidak ditampilkan)`] : []),
    "",
    "Tap nomor untuk pindah. `⑂` berarti sesi itu punya cabang — lihat `/branch`.",
  ].join("\n");

  return { text, ordered: shown };
}
