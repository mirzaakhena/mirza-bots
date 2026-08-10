import { expect, test } from "bun:test";
import {
  sendAttachments,
  assertNoButtonsWithFiles,
  prepareReply,
  type AttachmentApi,
} from "../../src/engine/engine";
import type { PlannedAttachment } from "../../src/engine/attach";

type Call = { method: "photo" | "document"; chatId: string; file: unknown };

function fakeApi(opts: { failOn?: number } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const send = (method: "photo" | "document") => async (chatId: string, file: unknown) => {
    n++;
    if (opts.failOn === n) throw new Error("Bad Request: file is too big");
    calls.push({ method, chatId, file });
    return { message_id: 900 + n };
  };
  const api: AttachmentApi = { sendPhoto: send("photo"), sendDocument: send("document") };
  return { api, calls };
}

const photo: PlannedAttachment = { path: "C:/x/a.png", kind: "photo", bytes: 10 };
const doc: PlannedAttachment = { path: "C:/x/b.pdf", kind: "document", bytes: 10 };

test("foto lewat sendPhoto, dokumen lewat sendDocument", async () => {
  const { api, calls } = fakeApi();
  await sendAttachments(api, "111", [photo, doc], (p) => ({ path: p }), () => {});
  expect(calls.map((c) => c.method)).toEqual(["photo", "document"]);
  expect(calls[0]!.chatId).toBe("111");
});

test("urutan kirim mengikuti urutan masukan", async () => {
  const { api, calls } = fakeApi();
  const three = [photo, doc, { ...photo, path: "C:/x/c.png" }];
  await sendAttachments(api, "111", three, (p) => p, () => {});
  expect(calls.map((c) => c.file)).toEqual(["C:/x/a.png", "C:/x/b.pdf", "C:/x/c.png"]);
});

test("onSent menerima id yang Telegram berikan, per berkas", async () => {
  const { api } = fakeApi();
  const seen: Array<[string, string]> = [];
  await sendAttachments(api, "111", [photo, doc], (p) => p, (a, id) => seen.push([a.path, id]));
  expect(seen).toEqual([
    ["C:/x/a.png", "901"],
    ["C:/x/b.pdf", "902"],
  ]);
});

test("mengembalikan jumlah berkas yang terkirim", async () => {
  const { api } = fakeApi();
  expect(await sendAttachments(api, "111", [photo, doc], (p) => p, () => {})).toBe(2);
});

// Yang sudah mendarat tidak bisa ditarik. Tanpa angka di pesan errornya,
// langkah berikutnya adalah mengirim ulang semuanya -- dan user terima dobel.
test("gagal di berkas kedua: pesannya menyebut berapa yang sudah terkirim", async () => {
  const { api } = fakeApi({ failOn: 2 });
  let message = "";
  try {
    await sendAttachments(api, "111", [photo, doc, photo], (p) => p, () => {});
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("1 of 3");
  expect(message).toContain("text already delivered");
  expect(message).toContain("file is too big");
});

// Berkas pertama sudah ada di HP user; barisnya harus tetap tercatat meski
// yang kedua meledak, kalau tidak riwayatnya berbohong.
test("berkas yang terlanjur terkirim tetap dilaporkan lewat onSent walau berikutnya gagal", async () => {
  const { api } = fakeApi({ failOn: 2 });
  const seen: string[] = [];
  try {
    await sendAttachments(api, "111", [photo, doc], (p) => p, (a) => seen.push(a.path));
  } catch {}
  expect(seen).toEqual(["C:/x/a.png"]);
});

test("daftar kosong tidak memanggil API sama sekali", async () => {
  const { api, calls } = fakeApi();
  expect(await sendAttachments(api, "111", [], (p) => p, () => {})).toBe(0);
  expect(calls.length).toBe(0);
});

// Berkas dikirim SESUDAH teks, jadi tombolnya nyangkut di pesan yang sekarang
// ada di atas berkas -- user harus scroll balik ke atas untuk menekannya.
test("buttons dan files bersama ditolak, dan pesannya menyebut jalan keluarnya", () => {
  let message = "";
  try {
    assertNoButtonsWithFiles([[{ text: "ya", data: "y" }]], ["C:/x/a.png"]);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("buttons");
  expect(message).toContain("files");
  expect(message).toContain("separate");
});

test("salah satu saja tidak ditolak", () => {
  expect(() => assertNoButtonsWithFiles([[{ text: "ya", data: "y" }]], undefined)).not.toThrow();
  expect(() => assertNoButtonsWithFiles(undefined, ["C:/x/a.png"])).not.toThrow();
  expect(() => assertNoButtonsWithFiles(undefined, undefined)).not.toThrow();
});

// files: [] setara dengan tidak memberikan files sama sekali.
test("files kosong bersama buttons tidak ditolak", () => {
  expect(() => assertNoButtonsWithFiles([[{ text: "ya", data: "y" }]], [])).not.toThrow();
});

const sizer = (sizes: Record<string, number>) => (p: string) => {
  const s = sizes[p];
  if (s === undefined) throw new Error("ENOENT");
  return s;
};

test("prepareReply mengembalikan potongan teks dan berkas terklasifikasi", () => {
  const out = prepareReply("halo", undefined, ["C:/x/a.png"], sizer({ "C:/x/a.png": 10 }));
  expect(out.parts.length).toBe(1);
  expect(out.planned).toEqual([{ path: "C:/x/a.png", kind: "photo", bytes: 10 }]);
});

test("tanpa files, planned kosong", () => {
  expect(prepareReply("halo", undefined, undefined, sizer({})).planned).toEqual([]);
});

// Inti kontraknya: berkas yang tidak ada membatalkan SEBELUM ada yang terkirim.
// Karena seluruh pagar duduk di fungsi ini dan fungsi ini dipanggil satu kali di
// atas loop pengiriman, urutan itu dijaga oleh struktur, bukan oleh ingatan.
test("berkas yang tidak ada membatalkan seluruh balasan", () => {
  expect(() => prepareReply("halo", undefined, ["C:/x/hilang.png"], sizer({}))).toThrow(/not found/);
});

// Pagar U-5 hanya menyala untuk label numerik 2 atau lebih -- label deskriptif
// bukan urusannya. prepareReply harus meneruskannya apa adanya, bukan
// melonggarkannya.
test("pagar tombol tak ternarasi tetap berlaku lewat prepareReply", () => {
  expect(() =>
    prepareReply(
      "halo tanpa daftar bernomor",
      [[{ text: "1", data: "a" }, { text: "2", data: "b" }]],
      undefined,
      sizer({})
    )
  ).toThrow(/numbered_buttons_without_list/);
});

test("buttons bersama files dibatalkan di sini juga", () => {
  expect(() =>
    prepareReply(
      "Options:\n1. ya\n2. tidak",
      [[{ text: "ya", data: "y" }]],
      ["C:/x/a.png"],
      sizer({ "C:/x/a.png": 10 })
    )
  ).toThrow(/cannot be combined/);
});

// Pagar tombol yang kedua, dan alasannya sama dengan yang pertama: kalau
// penolakannya baru terjadi di Telegram, potongan teks sebelumnya SUDAH
// mendarat di HP user dan tidak bisa ditarik kembali.
test("callback_data di atas 64 byte ditolak lewat prepareReply", () => {
  expect(() =>
    prepareReply("Pilih:", [[{ text: "Ya", data: "x".repeat(65) }]], undefined, sizer({}))
  ).toThrow(/callback_data_too_long/);
});

test("tombol AI tidak boleh memakai namespace lapisan slash", () => {
  expect(() =>
    prepareReply("Pilih:", [[{ text: "Bersihkan", data: "slash:go:/clear" }]], undefined, sizer({}))
  ).toThrow(/reserved_callback_data/);
});

test("tombol yang sah tetap lewat", () => {
  expect(() =>
    prepareReply("Pilih:", [[{ text: "Ya", data: "confirm_yes" }]], undefined, sizer({}))
  ).not.toThrow();
});
