/**
 * Menyusun cara memanggil statusline pendahulu. Murni.
 *
 * Kenapa ini perlu ada sama sekali: di Windows, ekstensi `.sh` terasosiasi ke
 *
 *   sh_auto_file = "C:\\Program Files\\Git\\git-bash.exe" --no-cd "%L" %*
 *
 * Jadi menyerahkan path `.sh` ke shell **tidak menjalankan skripnya** — ia
 * MEMBUKA jendela Git Bash baru, dan `spawnSync` menunggu jendela itu ditutup.
 * Terukur 2026-08-04: percobaan langsung menggantung sampai timeout dua menit,
 * dan user melihat berkas statusline-nya "dibuka" tiap kali bot dijalankan.
 *
 * Yang membuat bug ini bisa hidup tanpa ketahuan: di sistem lama rantainya
 * SELALU kosong (bug yang berbeda), jadi baris pemanggilan ini tidak pernah
 * benar-benar dieksekusi. Memperbaiki bug pertama membuka bug kedua yang
 * selama ini bersembunyi di belakangnya.
 *
 * Aturannya sesempit mungkin: hanya perintah yang token pertamanya berakhiran
 * `.sh` yang disentuh. Statusline orang lain bisa berupa `.exe`, `.cmd`, atau
 * baris perintah utuh — mengarang ulang perintah yang tadinya bekerja justru
 * merusak.
 */
export type ChainInvocation = { command: string; shell: boolean };

/** Token pertama, menghormati path berkutip yang memuat spasi. */
function splitFirstToken(s: string): { first: string; rest: string; wasQuoted: boolean } {
  const quoted = s.match(/^"([^"]*)"\s*(.*)$/);
  if (quoted) return { first: quoted[1] ?? "", rest: (quoted[2] ?? "").trim(), wasQuoted: true };
  const bare = s.match(/^(\S+)\s*(.*)$/);
  return { first: bare?.[1] ?? "", rest: (bare?.[2] ?? "").trim(), wasQuoted: false };
}

export function planChainInvocation(command: string): ChainInvocation {
  const trimmed = command.trim();
  const { first, rest } = splitFirstToken(trimmed);

  if (/\.sh$/i.test(first)) {
    // `bash` sengaja dibiarkan diselesaikan lewat PATH, bukan di-hard-code:
    // lokasi Git for Windows berbeda-beda antar-mesin, dan path yang salah
    // gagal lebih senyap daripada nama yang tidak ditemukan.
    const args = rest ? ` ${rest}` : "";
    return { command: `bash "${first}"${args}`, shell: true };
  }

  // Termasuk kasus `bash "x.sh"` dan `sh "x.sh"`: interpreter-nya sudah
  // dipilih pemanggil, dan menimpanya berarti menebak lebih tahu.
  return { command: trimmed, shell: true };
}
