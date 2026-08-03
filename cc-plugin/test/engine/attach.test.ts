import { expect, test } from "bun:test";
import {
  planAttachments,
  PHOTO_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  type PlannedAttachment,
} from "../../src/engine/attach";

// sizeOf palsu: peta path -> ukuran. Path yang tidak terdaftar melempar, persis
// seperti statSync pada berkas yang tidak ada.
function sizerOf(sizes: Record<string, number>): (p: string) => number {
  return (p) => {
    const s = sizes[p];
    if (s === undefined) throw new Error("ENOENT");
    return s;
  };
}

test("gambar di bawah batas foto dikirim sebagai foto", () => {
  const out = planAttachments(["C:/x/a.png"], sizerOf({ "C:/x/a.png": 1024 }));
  expect(out).toEqual([{ path: "C:/x/a.png", kind: "photo", bytes: 1024 }] as PlannedAttachment[]);
});

test("ekstensi non-gambar selalu dokumen", () => {
  const sizes = { "C:/x/a.pdf": 10, "C:/x/b.md": 10, "C:/x/c": 10 };
  const out = planAttachments(["C:/x/a.pdf", "C:/x/b.md", "C:/x/c"], sizerOf(sizes));
  expect(out.map((a) => a.kind)).toEqual(["document", "document", "document"]);
});

test("ekstensi gambar huruf besar tetap dikenali sebagai foto", () => {
  const out = planAttachments(["C:/x/A.PNG"], sizerOf({ "C:/x/A.PNG": 10 }));
  expect(out[0]!.kind).toBe("photo");
});

// Inti keputusan Q3: foto raksasa TURUN KELAS, bukan ditolak. Yang hilang cuma
// preview inline; berkasnya tetap sampai.
test("gambar di atas 10 MB turun kelas jadi dokumen, tidak ditolak", () => {
  const p = "C:/x/besar.png";
  const out = planAttachments([p], sizerOf({ [p]: PHOTO_MAX_BYTES + 1 }));
  expect(out[0]!.kind).toBe("document");
});

test("tepat 10 MB masih foto -- batasnya inklusif", () => {
  const p = "C:/x/pas.png";
  const out = planAttachments([p], sizerOf({ [p]: PHOTO_MAX_BYTES }));
  expect(out[0]!.kind).toBe("photo");
});

// Pesan errornya harus menyebut NAMA dan UKURAN: tanpa itu user cuma tahu
// "gagal", dan tidak tahu berkas mana dari lima yang jadi soal.
test("di atas 50 MB ditolak, dengan nama berkas dan ukurannya di pesan", () => {
  const p = "C:/x/raksasa.zip";
  let message = "";
  try {
    planAttachments([p], sizerOf({ [p]: ATTACHMENT_MAX_BYTES + 1 }));
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("raksasa.zip");
  expect(message).toContain("50MB");
  expect(message).toMatch(/50\.0MB/);
});

test("berkas yang tidak ada ditolak dengan path-nya", () => {
  let message = "";
  try {
    planAttachments(["C:/x/hilang.png"], sizerOf({}));
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("not found");
  expect(message).toContain("C:/x/hilang.png");
});

// Path relatif diselesaikan terhadap cwd proses MCP -- bukan folder yang ada di
// kepala pemanggilnya. Ditolak di sini, di mana pesannya bisa menyebut sebabnya.
test("path relatif ditolak", () => {
  let message = "";
  try {
    planAttachments(["docs/a.png"], sizerOf({ "docs/a.png": 10 }));
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("absolute");
});

test("path POSIX absolut diterima", () => {
  const out = planAttachments(["/home/m/a.png"], sizerOf({ "/home/m/a.png": 10 }));
  expect(out[0]!.kind).toBe("photo");
});

// Validasi mendahului pengiriman apa pun, jadi kegagalan di tengah daftar tidak
// boleh meninggalkan hasil separuh yang terlihat sah.
test("berkas bermasalah di posisi kedua tetap membatalkan seluruhnya", () => {
  const sizes = { "C:/x/a.png": 10, "C:/x/c.png": 10 };
  expect(() => planAttachments(["C:/x/a.png", "C:/x/b.png", "C:/x/c.png"], sizerOf(sizes))).toThrow();
});

test("daftar kosong bukan kesalahan", () => {
  expect(planAttachments([], sizerOf({}))).toEqual([]);
});
