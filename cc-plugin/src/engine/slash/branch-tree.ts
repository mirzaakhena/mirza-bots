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
 * Jawaban lengkap untuk `/branch` polos.
 *
 * Nol sesi tidak mungkin dalam praktik (sesi yang sedang berjalan pasti ada),
 * tapi tetap dijawab kalimat -- blok kode kosong terlihat seperti kerusakan.
 */
export function renderBranchTree(
  sessions: SessionInfo[],
  currentId: string | undefined,
  now: number
): string {
  if (sessions.length === 0) {
    return "Belum ada sesi yang tercatat.\n\nBuat cabang: `/branch <nama>`";
  }

  const roots = buildForest(sessions);
  const lines = treeLines(roots, currentId);
  const ordered = flatten(roots);

  const detail = ordered.map((s, i) => {
    const here = s.id === currentId ? " ← sekarang" : "";
    return `${i + 1}. ${labelOf(s)} · ${shortAge(s.mtime, now)}${here}`;
  });

  return [
    "```",
    ...lines,
    "```",
    ...detail,
    "",
    "Buat cabang: `/branch <nama>`",
  ].join("\n");
}
