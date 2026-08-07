import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyStored } from "../../src/engine/reply-stored";

type Dikirim = { text: string; other: unknown };

function ctxPalsu(messageId = 42) {
  const dikirim: Dikirim[] = [];
  return {
    dikirim,
    ctx: {
      reply: async (text: string, other?: unknown) => {
        dikirim.push({ text, other });
        return { message_id: messageId };
      },
    },
  };
}

describe("replyStored", () => {
  test("mengirim teks apa adanya ke Telegram", async () => {
    const { ctx, dikirim } = ctxPalsu();
    await replyStored(ctx, () => {}, "✏️ Ganti nama sesi jadi `apa-saja`");
    expect(dikirim).toHaveLength(1);
    expect(dikirim[0]!.text).toBe("✏️ Ganti nama sesi jadi `apa-saja`");
  });

  // Inti perbaikannya: sebelum ini jalur slash mengirim TANPA mencatat, dan
  // 12,9% pesan mirza_02_bot (11 dari 85) tidak pernah masuk conversations.db --
  // termasuk SETIAP jawaban /context yang pernah dikirim.
  test("mencatat message_id dari Telegram beserta teksnya", async () => {
    const { ctx } = ctxPalsu(77);
    const tercatat: { messageId: string; text: string }[] = [];
    await replyStored(ctx, (messageId, text) => tercatat.push({ messageId, text }), "halo");
    expect(tercatat).toEqual([{ messageId: "77", text: "halo" }]);
  });

  test("opsi (mis. tombol) diteruskan apa adanya", async () => {
    const { ctx, dikirim } = ctxPalsu();
    const opsi = { reply_markup: { inline_keyboard: [] } };
    await replyStored(ctx, () => {}, "pilih", opsi);
    expect(dikirim[0]!.other).toBe(opsi);
  });

  // Pesannya sudah ada di HP user. Melempar di sini akan membuat pemanggil
  // mengira pengirimannya gagal -- pola yang sama sudah dipakai storeOutgoing
  // di jalur reply AI, dan alasannya sama persis.
  test("gagal MENCATAT tidak menjatuhkan pengiriman", async () => {
    const { ctx, dikirim } = ctxPalsu();
    await replyStored(ctx, () => {
      throw new Error("db terkunci");
    }, "tetap terkirim");
    expect(dikirim).toHaveLength(1);
  });

  // Kebalikannya WAJIB tidak berlaku: baris tanpa message_id tidak akan pernah
  // bisa dikutip, dan mencatat yang tidak terkirim membuat riwayat berbohong.
  test("gagal MENGIRIM berarti tidak ada yang dicatat", async () => {
    const gagal = {
      reply: async () => {
        throw new Error("429 Too Many Requests");
      },
    };
    let dicatat = 0;
    await expect(replyStored(gagal, () => dicatat++, "tidak sampai")).rejects.toThrow(
      "429 Too Many Requests"
    );
    expect(dicatat).toBe(0);
  });
});

/**
 * Pagar mekanis, bukan pengingat.
 *
 * Bug ini lahir karena ADA DUA PINTU KELUAR dan cuma satu yang punya buku tamu.
 * Menambal sepuluh pemanggil menyelesaikan hari ini; yang menyelesaikan besok
 * adalah pagar yang membuat pintu kesebelas mustahil ditambahkan diam-diam.
 *
 * ⚠️ Perbaikan lama untuk kelas bug yang SAMA (spec §2.3) menutup sisi MASUK
 * saja, lalu meninggalkan komentar yang berbunyi seolah kasusnya sudah selesai.
 * Komentar tidak menjaga apa pun. Test ini menjaga.
 */
describe("pagar: tidak ada pintu keluar kedua", () => {
  test("engine.ts tidak memanggil ctx.reply langsung", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/engine/engine.ts"), "utf8");
    const langsung = src.match(/\bctx\.reply\(/g) ?? [];
    expect(langsung).toHaveLength(0);
  });
});
