import { test, expect, describe } from "bun:test";
import {
  buildCommandMenu,
  COMMAND_DESCRIPTIONS,
  staleMenuScopes,
} from "../../../src/engine/slash/menu";
import { KNOWN_COMMANDS } from "../../../src/engine/slash/classify";

describe("buildCommandMenu", () => {
  test("satu entri untuk tiap command yang benar-benar dikenal", () => {
    expect(buildCommandMenu()).toHaveLength(KNOWN_COMMANDS.length);
  });

  // Telegram menolak entri yang memuat garis miring: payload setMyCommands
  // memakai nama telanjang, dan aplikasinya yang menambahkan "/" saat menampil.
  test("nama didaftarkan tanpa garis miring", () => {
    for (const entry of buildCommandMenu()) {
      expect(entry.command.startsWith("/")).toBe(false);
    }
  });

  test("nama patuh bentuk yang diterima Telegram", () => {
    for (const entry of buildCommandMenu()) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  test("tiap entri punya deskripsi yang tidak kosong", () => {
    for (const entry of buildCommandMenu()) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  // Urutan menu = urutan KNOWN_COMMANDS, dan itu yang dilihat user di HP.
  // Dikunci supaya penataan ulang yang tidak disengaja ketahuan di sini.
  test("/context muncul PALING ATAS di menu", () => {
    expect(buildCommandMenu()[0]?.command).toBe("context");
  });

  test("mendaftarkan lima command -- dan hanya itu di tahap ini", () => {
    expect(buildCommandMenu().map((e) => e.command).sort()).toEqual([
      "branch",
      "context",
      "new",
      "rename",
      "switch",
    ]);
  });

  // Pagar untuk tahap berikutnya: menambah /switch ke KNOWN_COMMANDS tanpa
  // menulis deskripsinya akan memunculkan entri berdeskripsi kosong di menu HP
  // user -- gagal di sini jauh lebih murah daripada gagal di layarnya.
  test("setiap command dikenal wajib punya deskripsi", () => {
    for (const name of KNOWN_COMMANDS) {
      expect(COMMAND_DESCRIPTIONS[name]).toBeDefined();
    }
  });

  // Menu adalah papan nama, bukan dapur. Mendaftarkan sesuatu yang tidak
  // dikenal berarti menjanjikan barang yang tidak ada -- persis kenapa daftar
  // ini lahir dari KNOWN_COMMANDS dan bukan dari daftar terpisah.
  test("tidak mendaftarkan apa pun di luar daftar dikenal", () => {
    const dikenal = new Set(KNOWN_COMMANDS.map((c) => c.slice(1)));
    for (const entry of buildCommandMenu()) {
      expect(dikenal.has(entry.command)).toBe(true);
    }
  });
});

/**
 * Scope yang HARUS dikosongkan supaya menu default benar-benar terlihat.
 *
 * Telegram menyimpan daftar command per scope, dan scope yang lebih spesifik
 * MENANG: chat > all_private_chats > default. `setMyCommands` tanpa `scope`
 * menulis ke yang paling LEMAH -- jadi daftar kita benar dan tetap tak terlihat
 * kalau ada sisa di scope yang lebih kuat.
 *
 * Sistem lama sengaja menulis ke keduanya (`plugins/telegram/server.ts:162`
 * per-chat untuk chat berpasangan, `all_private_chats` untuk /start + /help).
 * Sisa itu hidup di SERVER Telegram, bukan di berkas mana pun di mesin ini:
 * mengarsipkan state lama tidak bisa menghapusnya, dan reconcile yang tahu
 * caranya (`server.ts:175`) hanya jalan kalau plugin lama hidup -- yaitu mati
 * persis pada saat ia dibutuhkan.
 *
 * Terukur di `bot-06` 2026-08-10: scope chat memuat 10 command lama, jadi menu
 * di HP user tidak berubah sedikit pun sesudah migrasi, dan tidak ada satu pun
 * error di mana pun.
 */
describe("staleMenuScopes", () => {
  test("selalu memuat all_private_chats, bahkan saat allowFrom kosong", () => {
    // /start + /help sistem lama tinggal di sini tanpa peduli chat mana pun,
    // jadi daftar allowFrom TIDAK boleh jadi syarat pembersihannya.
    expect(staleMenuScopes([])).toEqual([{ type: "all_private_chats" }]);
  });

  test("satu scope chat untuk tiap chat id di allowFrom", () => {
    expect(staleMenuScopes(["1121398977", "42"])).toEqual([
      { type: "all_private_chats" },
      { type: "chat", chat_id: 1121398977 },
      { type: "chat", chat_id: 42 },
    ]);
  });

  // Telegram menerima string maupun angka, tapi bentuknya dikunci di sini:
  // config.json menyimpan allowFrom sebagai string, dan yang lewat tanpa
  // konversi akan lolos test yang hanya memeriksa "ada isinya".
  test("chat_id dikirim sebagai angka, bukan string", () => {
    const scope = staleMenuScopes(["77"])[1];
    expect(scope).toEqual({ type: "chat", chat_id: 77 });
    expect(typeof (scope as { chat_id: unknown }).chat_id).toBe("number");
  });

  // Satu entri salah ketik tidak boleh menjatuhkan pembersihan chat lain --
  // sistem lama pun melewatinya satu-satu (server.ts:158), bukan berhenti.
  test("chat id yang bukan angka dilewati, bukan menjatuhkan sisanya", () => {
    expect(staleMenuScopes(["abc", "9"])).toEqual([
      { type: "all_private_chats" },
      { type: "chat", chat_id: 9 },
    ]);
  });

  test("chat id kembar tidak menghasilkan dua panggilan", () => {
    expect(staleMenuScopes(["5", "5"])).toEqual([
      { type: "all_private_chats" },
      { type: "chat", chat_id: 5 },
    ]);
  });
});

describe("deskripsi menu sama dengan sistem lama", () => {
  // Disalin persis dari menuHint di plugins/telegram/commands-registry.ts.
  // Dikunci sebagai teks harfiah, bukan "ada isinya": selama migrasi, dua bot
  // yang sama tidak boleh berbicara dengan dua suara berbeda di menu yang
  // dilihat user setiap hari.
  test("teks persis, bahasa Inggris, sama seperti sistem lama", () => {
    expect(COMMAND_DESCRIPTIONS["/context"]).toBe("Context window and session info");
    expect(COMMAND_DESCRIPTIONS["/rename"]).toBe("Rename the current session");
    expect(COMMAND_DESCRIPTIONS["/new"]).toBe("Start a fresh named session");
  });
});
