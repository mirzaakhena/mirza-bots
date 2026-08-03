import { expect, test } from "bun:test";
import { sendAttachments, type AttachmentApi } from "../../src/engine/engine";
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
