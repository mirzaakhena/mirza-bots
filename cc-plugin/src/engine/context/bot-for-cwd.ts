/**
 * Bot mana yang rumahnya folder ini. Murni.
 *
 * Pola ini SUDAH ADA dan sudah terbukti di `hooks/session-start.ts` -- disalin,
 * bukan direka ulang, supaya keduanya tidak bisa berbeda pendapat soal folder
 * mana milik siapa. Dua jawaban yang berbeda untuk pertanyaan yang sama adalah
 * bug yang menunggu waktu.
 *
 * `null` berarti folder ini bukan rumah bot mana pun. Pemanggilnya (bridge)
 * memperlakukan itu sebagai "jangan tulis apa-apa, tapi TETAP teruskan ke
 * statusline pendahulu" -- folder yang bukan bot tidak boleh kehilangan
 * statusline-nya hanya karena bridge kebetulan terpasang di sana.
 */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function botForCwd(config: unknown, cwd: string): string | null {
  if (typeof config !== "object" || config === null) return null;
  const bots = (config as { bots?: unknown }).bots;
  if (typeof bots !== "object" || bots === null || Array.isArray(bots)) return null;

  const target = normalize(cwd);
  for (const [name, bot] of Object.entries(bots as Record<string, unknown>)) {
    const home = (bot as { home?: unknown } | null)?.home;
    // Kecocokan PERSIS, bukan prefix: folder anak bukan bot induknya, dan
    // menganggapnya begitu akan menulis status bot ke sesi yang bukan miliknya.
    if (typeof home === "string" && normalize(home) === target) return name;
  }
  return null;
}
