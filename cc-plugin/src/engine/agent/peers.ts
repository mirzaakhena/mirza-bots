/**
 * Daftar bot adalah ISI FOLDER INDUK, dibaca langsung -- bukan berkas daftar.
 *
 * Usul awalnya sebuah berkas peer di tiap folder; user mencabutnya sendiri
 * setelah dibahas. N bot berarti N salinan daftar yang sama, menambah bot ke-7
 * berarti menyunting enam berkas, dan yang terlewat membuat satu bot tuli
 * sebelah SECARA DIAM-DIAM. Itu persis penyakit yang dulu membuat config.json
 * disentralkan -- jadi mengulanginya di bentuk lain akan membawa kembali
 * masalah yang justru sedang dibuang.
 *
 * Validasi ikut gratis: sebuah folder adalah bot bila `config.json`-nya BISA
 * DIBACA SEBAGAI CONFIG BOT. Salah ketik nama tujuan langsung ketahuan, bukan
 * hilang tanpa jejak.
 *
 * ⚠️ Versi pertama cuma memeriksa KEBERADAAN config.json, dan itu terlalu
 * longgar -- terukur di workspace nyata 2026-08-05: `wa-kajian-aggregator`
 * punya config.json sendiri (`webPort`, `ollamaUrl`, `dbPath`) dan langsung
 * terbaca sebagai bot. Konsekuensinya bukan sekadar daftar yang keliru:
 * `agent_send` ke situ akan MEMBUAT `inbox/` di dalam project orang lain dan
 * menaruh berkas di sana. `config.json` adalah nama berkas yang terlalu umum
 * untuk dijadikan tanda pengenal; yang membedakan adalah isinya.
 *
 * Sengaja BEDA dari `identifyBot`, yang tetap memakai keberadaan berkas: untuk
 * DIRI SENDIRI, config yang rusak adalah kerusakan yang harus dilaporkan apa
 * adanya ("config tidak bisa dibaca"), bukan disamarkan jadi "ini bukan folder
 * bot". Untuk TETANGGA, "bukan bot" memang jawaban yang benar.
 *
 * ⚠️ BATAS YANG DISADARI SAAT MEMUTUSKAN: konvensi ini mengunci semua bot pada
 * SATU folder induk. Bot di drive lain -- apalagi di mesin lain -- tidak
 * terjangkau olehnya. Diterima karena saat ini semua bot memang bertetangga,
 * dan karena MENAMBAHKAN berkas daftar nanti itu murah, sedangkan MEMBUANG
 * berkas daftar yang terlanjur dipakai itu mahal.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { botNameFrom, configPathIn, inboxDirIn } from "../paths";
import { loadConfig } from "../config";

/**
 * Apakah folder ini benar-benar rumah sebuah bot.
 *
 * Membaca config-nya, bukan sekadar memeriksa berkasnya ada. Config yang tidak
 * lolos schema -- milik project lain, rusak, atau bentuk lama -- menjawab
 * `false` tanpa mengeluh: ini bukan tempat untuk melaporkan kerusakan config
 * orang lain, cuma tempat untuk menjawab "ini bot atau bukan".
 */
function isBotFolder(folder: string): boolean {
  try {
    loadConfig(configPathIn(folder));
    return true;
  } catch {
    return false;
  }
}

export function listPeers(botHome: string): string[] {
  const parent = dirname(botHome);
  const self = botNameFrom(botHome);
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    // Folder induk tidak terbaca: tidak ada tetangga yang bisa dipastikan ada,
    // dan menebak satu pun lebih buruk daripada menjawab kosong.
    return [];
  }
  return entries.filter((name) => name !== self && isBotFolder(join(parent, name)));
}

export function resolvePeer(
  botHome: string,
  name: string
): { ok: true; inbox: string } | { ok: false; error: string } {
  // Nama tujuan ditulis AI. Tanpa pagar ini, "../.." adalah alamat yang sah dan
  // pesan bisa mendarat di mana saja di disk.
  if (name.length === 0 || /[\\/]/.test(name) || name === "." || name === "..") {
    return { ok: false, error: `nama bot "${name}" tidak sah: harus nama folder polos` };
  }

  const peers = listPeers(botHome);
  if (!peers.includes(name)) {
    const known =
      peers.length > 0
        ? `Yang ada: ${peers.join(", ")}.`
        : `Tidak ada bot lain di folder induk.`;
    return { ok: false, error: `Tidak ada bot bernama "${name}" di sebelah folder ini. ${known}` };
  }

  return { ok: true, inbox: inboxDirIn(join(dirname(botHome), name)) };
}
