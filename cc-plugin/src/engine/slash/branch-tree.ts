/**
 * Menggambar pohon sesi untuk `/branch` polos. Murni.
 *
 * ## Kenapa lebarnya 19 kolom, bukan selera
 *
 * Diukur langsung di HP user 2026-08-09: **Telegram tidak punya scroll
 * horizontal**. Blok kode DIBUNGKUS, dan begitu satu baris dibungkus, garis
 * `├ │ └` kehilangan kolomnya -- anak tampak menempel pada induk yang salah.
 * Pohon yang salah jauh lebih buruk daripada pohon yang terpotong.
 *
 * Lebar terpakai terukur: ~28 kolom pada font kecil, **~19 pada font besar**.
 * Yang dipakai adalah yang besar: tampilan tidak boleh rusak hanya karena
 * pembaca memperbesar hurufnya.
 *
 * ## Kenapa bentuk dan detail dipisah
 *
 * 19 kolom habis oleh indentasi + nama saja. Jadi blok kode mengurus BENTUK
 * (siapa anak siapa) dan daftar bernomor di bawahnya mengurus DETAIL (nama
 * penuh, umur). Keduanya memakai urutan yang sama, jadi nomor di daftar
 * menunjuk baris yang sama di pohon.
 */
import type { SessionInfo } from "../sessions";

/** Anggaran keras satu baris pohon. Lihat komentar header untuk asal angkanya. */
export const TREE_WIDTH = 19;

/**
 * Sesi yang ditampilkan, terbaru dulu. Bot harian mengumpulkan puluhan
 * transcript, dan pohon sepanjang itu tidak terbaca di HP -- lebih buruk lagi,
 * ia mendorong satu-satunya baris yang berguna ("Buat cabang: ...") keluar
 * layar. Yang dipotong DIKATAKAN jumlahnya; pemotongan diam-diam terbaca
 * sebagai "cuma segini sesinya".
 */
export const MAX_TREE_SESSIONS = 12;

/** Penanda sesi yang sedang aktif. Ditaruh di ujung, sesudah nama. */
const HERE = " <";

export type TreeNode = { session: SessionInfo; children: TreeNode[] };

/**
 * Menyusun hutan dari daftar datar lewat `forkedFrom`.
 *
 * Disebut hutan, bukan pohon: sesi yang lahir dari `/clear` tidak punya induk
 * sama sekali, jadi akarnya banyak. Sesi yang induknya sudah tidak ada
 * (transcriptnya dihapus atau diarsipkan) DIANGKAT jadi akar -- membuangnya
 * akan menghilangkan sesi yang masih bisa dibuka user, dan itu kehilangan
 * diam-diam.
 */
export function buildForest(sessions: SessionInfo[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of sessions) byId.set(s.id, { session: s, children: [] });

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.session.forkedFrom?.sessionId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Urutan baca: akar, lalu anak-anaknya, dalam urutan daftar aslinya. */
export function flatten(roots: TreeNode[]): SessionInfo[] {
  const out: SessionInfo[] = [];
  const walk = (n: TreeNode): void => {
    out.push(n.session);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** Umur dalam bentuk sependek mungkin -- kolomnya mahal. */
export function shortAge(mtime: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - mtime) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}j`;
  return `${Math.floor(hours / 24)}h`;
}

/**
 * Label sesi tanpa nama. Bukan "(tanpa nama)": id pendeknya harus ikut supaya
 * sesi itu tetap bisa dirujuk user maupun `/switch`.
 */
export function labelOf(s: SessionInfo): string {
  return s.title ?? `sesi ${s.id.slice(0, 8)}`;
}

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Baris-baris pohon. Prefiks dibangun dari nenek moyang, bukan dari kedalaman:
 * `│` hanya boleh muncul kalau induknya MASIH punya adik di bawahnya --
 * kalau tidak, garisnya menggantung menunjuk apa-apa.
 */
export function treeLines(roots: TreeNode[], currentId: string | undefined): string[] {
  const lines: string[] = [];

  const walk = (node: TreeNode, prefix: string, connector: string): void => {
    const here = node.session.id === currentId ? HERE : "";
    const budget = TREE_WIDTH - prefix.length - connector.length - here.length;
    lines.push(`${prefix}${connector}${truncate(labelOf(node.session), budget)}${here}`);

    const childPrefix = connector === "" ? "" : prefix + (connector === "└ " ? "  " : "│ ");
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      walk(child, childPrefix, last ? "└ " : "├ ");
    });
  };

  for (const root of roots) walk(root, "", "");
  return lines;
}

/**
 * Silsilah sesi yang sedang berjalan: naik lewat `forkedFrom` sampai leluhur
 * paling atas, lalu turunkan SELURUH keturunannya.
 *
 * Sesi lain di project ini sengaja tidak ikut. `/branch` menjawab "saya di
 * mana, dan cabang apa saja yang serumpun" -- daftar sesi yang tidak
 * berhubungan cuma memanjangkan layar tanpa menjawab pertanyaan itu, dan
 * mendorong satu-satunya baris berguna keluar layar (terlihat 2026-08-10).
 *
 * Rantai naiknya dijaga `seen`: transcript yang rusak atau disunting tangan
 * bisa membuat `forkedFrom` melingkar, dan lingkaran itu akan menggantung bot
 * selamanya alih-alih menjawab.
 */
export function lineageOf(sessions: SessionInfo[], currentId: string | undefined): SessionInfo[] {
  if (currentId === undefined) return sessions;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (!byId.has(currentId)) return sessions;

  let rootId = currentId;
  const seen = new Set<string>([rootId]);
  for (;;) {
    const parentId = byId.get(rootId)?.forkedFrom?.sessionId;
    if (!parentId || !byId.has(parentId) || seen.has(parentId)) break;
    rootId = parentId;
    seen.add(parentId);
  }

  const family = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of sessions) {
      const p = s.forkedFrom?.sessionId;
      if (p && family.has(p) && !family.has(s.id)) {
        family.add(s.id);
        grew = true;
      }
    }
  }
  return sessions.filter((s) => family.has(s.id));
}

export type BranchView = {
  /** Teks CommonMark siap kirim. */
  text: string;
  /**
   * Sesi dalam urutan yang SAMA dengan nomor di teks. Tombol dibangun dari
   * daftar ini, jadi nomor di badan pesan dan nomor di tombol tidak bisa
   * berbeda -- keduanya lahir dari satu urutan.
   */
  ordered: SessionInfo[];
};

/**
 * Jawaban lengkap untuk `/branch` polos.
 *
 * Nol sesi tidak mungkin dalam praktik (sesi yang sedang berjalan pasti ada),
 * tapi tetap dijawab kalimat -- blok kode kosong terlihat seperti kerusakan.
 */
export function renderBranchTree(
  sessions: SessionInfo[],
  currentId: string | undefined,
  now: number
): BranchView {
  if (sessions.length === 0) {
    return {
      text: "Belum ada sesi yang tercatat.\n\nBuat cabang: `/branch <nama>`",
      ordered: [],
    };
  }

  const family = lineageOf(sessions, currentId);

  // Dipotong SEBELUM hutan disusun: anak yang induknya tidak ikut tampil naik
  // jadi akar sendiri (buildForest sudah menanganinya), jadi tidak ada sesi
  // yang lenyap dari daftar hanya karena induknya terpotong.
  const shown = family.slice(0, MAX_TREE_SESSIONS);
  const hidden = family.length - shown.length;

  const roots = buildForest(shown);
  const lines = treeLines(roots, currentId);
  const ordered = flatten(roots);

  // Nama kembar TIDAK dilarang (keputusan user 2026-08-10): identitas sesi
  // adalah `session_id`, dan tombol pindah membawa UUID utuh, jadi kembar tidak
  // pernah menyesatkan mesin. Yang tersisa menyesatkan MATA -- dua baris
  // bertulisan sama -- dan itu diselesaikan di sini: id pendek ditempel HANYA
  // pada yang kembar, supaya nama yang unik tetap bersih.
  const counts = new Map<string, number>();
  for (const s of ordered) counts.set(labelOf(s), (counts.get(labelOf(s)) ?? 0) + 1);

  const detail = ordered.map((s, i) => {
    const here = s.id === currentId ? " ← sekarang" : "";
    const label = labelOf(s);
    const disambig = (counts.get(label) ?? 0) > 1 ? ` (${s.id.slice(0, 8)})` : "";
    return `${i + 1}. ${label}${disambig} · ${shortAge(s.mtime, now)}${here}`;
  });

  const text = [
    "```",
    ...lines,
    "```",
    ...detail,
    ...(hidden > 0 ? [`(${hidden} sesi lebih lama tidak ditampilkan)`] : []),
    "",
    "Tap nomor untuk pindah ke sesi itu.",
    "Buat cabang: `/branch <nama>`",
  ].join("\n");

  return { text, ordered };
}
