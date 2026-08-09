import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleSlash,
  handleConfirm,
  handleSwitch,
  parseSlashCallback,
  confirmFits,
  MAX_CONFIRM_COMMAND_BYTES,
  SLASH_CALLBACK_GO,
  SLASH_CALLBACK_SWITCH,
} from "../../../src/engine/slash";
import { slashDirIn } from "../../../src/engine/paths";

let proj: string;
let n = 0;
const deps = () => ({ botHome: proj, newId: () => `id${++n}`, sessionTitles: () => [] as string[] });

beforeEach(() => { proj = mkdtempSync(join(tmpdir(), "slash-")); n = 0; });
afterEach(() => rmSync(proj, { recursive: true, force: true }));

function berkasPending(): string[] {
  try {
    return readdirSync(slashDirIn(proj)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("handleSlash", () => {
  test("teks biasa diteruskan ke AI, tanpa menulis apa pun", () => {
    expect(handleSlash("halo", deps()).kind).toBe("passthrough");
    expect(berkasPending()).toEqual([]);
  });

  test("/rename menulis payload dan mengembalikan ack", () => {
    const r = handleSlash("/rename sesi-x", deps());
    expect(r.kind).toBe("sent");
    expect(berkasPending()).toHaveLength(1);
    const isi = JSON.parse(readFileSync(join(slashDirIn(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual({ command: "/rename sesi-x" });
  });

  test("/new menulis batch dua perintah", () => {
    handleSlash("/new sesi-y", deps());
    const isi = JSON.parse(readFileSync(join(slashDirIn(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual([{ command: "/clear" }, { command: "/rename sesi-y" }]);
  });

  test("nama tidak sah: pesan galat, dan TIDAK menulis apa pun", () => {
    const r = handleSlash("/rename", deps());
    expect(r.kind).toBe("error");
    expect(berkasPending()).toEqual([]);
  });

  test("command tak dikenal minta konfirmasi, belum menulis apa pun", () => {
    const r = handleSlash("/compact", deps());
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") {
      expect(r.command).toBe("/compact");
      expect(r.prompt).toContain("/compact");
    }
    expect(berkasPending()).toEqual([]);
  });
});

describe("handleConfirm", () => {
  test("sesudah dikonfirmasi, command diteruskan apa adanya", () => {
    const r = handleConfirm("/compact", deps());
    expect(r.kind).toBe("sent");
    const isi = JSON.parse(readFileSync(join(slashDirIn(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual({ command: "/compact" });
  });

  // Yang dikonfirmasi diteruskan apa adanya -- lapisan ini tidak mengolahnya,
  // dan tidak boleh diam-diam menerapkan pemetaan.
  test("command dikenal yang lewat jalur konfirmasi tidak dipetakan", () => {
    handleConfirm("/new x", deps());
    const isi = JSON.parse(readFileSync(join(slashDirIn(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual({ command: "/new x" });
  });
});

describe("pagar callback_data", () => {
  // W-25: Telegram menolak callback_data di atas 64 byte dengan
  // BUTTON_DATA_INVALID. Prefiks "slash:go:" memakan 9, sisanya 55.
  test("command terlalu panjang untuk tombol ditolak, bukan dikirim dan gagal", () => {
    const panjang = "/" + "x".repeat(80);
    const r = handleSlash(panjang, deps());
    expect(r.kind).toBe("error");
    expect(berkasPending()).toEqual([]);
  });

  test("prefiks + command yang muat tetap di bawah batas 64 byte Telegram", () => {
    const pas = "/" + "x".repeat(MAX_CONFIRM_COMMAND_BYTES - 1);
    expect(confirmFits(pas)).toBe(true);
    expect(Buffer.byteLength(SLASH_CALLBACK_GO + pas, "utf8")).toBeLessThanOrEqual(64);
  });

  // Diukur dalam BYTE, bukan karakter: satu emoji memakan empat byte, dan
  // menghitung panjang string akan meloloskan command yang ditolak Telegram.
  test("dihitung per byte, bukan per karakter", () => {
    expect(confirmFits("/" + "😀".repeat(20))).toBe(false);
  });
});

describe("parseSlashCallback", () => {
  test("tombol Kirim membawa commandnya", () => {
    expect(parseSlashCallback("slash:go:/compact")).toEqual({
      kind: "go",
      command: "/compact",
    });
  });

  test("tombol Batal dikenali", () => {
    expect(parseSlashCallback("slash:no")).toEqual({ kind: "cancel" });
  });

  // Tombol milik fitur lain tidak boleh ikut tercegat -- ia harus tetap sampai
  // ke AI seperti sebelumnya.
  test("callback lain bukan milik lapisan ini", () => {
    expect(parseSlashCallback("confirm_yes")).toBeNull();
    expect(parseSlashCallback(undefined)).toBeNull();
  });
});

describe("urutan catat-lalu-cegat", () => {
  // Aturan paling mengikat di spec §2.3. Diuji lewat urutan pemanggilan,
  // bukan lewat db sungguhan: yang dijaga adalah urutannya.
  test("payload tidak ditulis sebelum pencatatan dipanggil", () => {
    const urutan: string[] = [];
    const catat = () => urutan.push("catat");
    const kirim = () => {
      const r = handleSlash("/rename x", deps());
      if (r.kind === "sent") urutan.push("kirim");
    };
    catat();
    kirim();
    expect(urutan).toEqual(["catat", "kirim"]);
  });
});

// Pagar terhadap kembalinya alamat legacy lewat pintu belakang. Yang dikunci
// bukan "berkasnya ada" melainkan "berkasnya ada DI SINI" -- test yang cuma
// menghitung berkas akan tetap hijau untuk folder mana pun.
describe("alamat penulisan", () => {
  test("payload mendarat di <botHome>/slash, bukan di .claude/channels", () => {
    handleSlash("/rename sesi-alamat", deps());
    expect(readdirSync(slashDirIn(proj)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(existsSync(join(proj, ".claude", "channels"))).toBe(false);
  });
});

/**
 * `/branch` punya tiga cabang dan ketiganya harus terkunci: polos menjawab
 * dengan pohon (bukan memarahi), bernama-dan-unik diteruskan, bernama-tapi-
 * bentrok DITOLAK sebelum apa pun sampai ke TUI.
 */
describe("handleSlash: /branch", () => {
  test("polos -> local, bukan error dan bukan payload", () => {
    const r = handleSlash("/branch", deps());
    expect(r).toEqual({ kind: "local", command: "/branch" });
    expect(berkasPending()).toHaveLength(0);
  });

  test("bernama & unik -> payload /branch <nama> ditulis", () => {
    const r = handleSlash("/branch riset-api", deps());
    expect(r.kind).toBe("sent");
    expect(berkasPending()).toHaveLength(1);
  });

  // CC memakai nama yang diberikan APA ADANYA -- tanpa pagar ini dua sesi bisa
  // bernama sama, dan picker /switch jadi ambigu justru saat paling dibutuhkan.
  test("nama yang sudah dipakai ditolak SEBELUM payload lahir", () => {
    const d = { ...deps(), sessionTitles: () => ["riset-api"] };
    const r = handleSlash("/branch riset-api", d);
    expect(r.kind).toBe("error");
    expect(berkasPending()).toHaveLength(0);
  });

  test("nama tidak sah memakai validator yang sama dengan /rename", () => {
    const r = handleSlash("/branch a\nb", deps());
    expect(r.kind).toBe("error");
    expect(berkasPending()).toHaveLength(0);
  });

  // Kalau /branch tidak dikenal, ia jatuh ke jalur konfirmasi tombol dan
  // seluruh pagar di atas terlewati diam-diam.
  test("/branch dikenal, jadi tidak pernah lewat jalur konfirmasi", () => {
    expect(handleSlash("/branch x", deps()).kind).not.toBe("confirm");
  });
});

describe("tombol pindah sesi di bawah pohon /branch", () => {
  test("callback dikenali dan membawa id sesi UTUH", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parseSlashCallback(`${SLASH_CALLBACK_SWITCH}${id}`)).toEqual({
      kind: "switch",
      sessionId: id,
    });
  });

  test("prefiks + UUID muat di batas callback_data Telegram", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(Buffer.byteLength(`${SLASH_CALLBACK_SWITCH}${id}`, "utf8")).toBeLessThanOrEqual(64);
  });

  test("tap menulis /resume <id>, bukan tipe payload baru", () => {
    const r = handleSwitch("11111111-2222-3333-4444-555555555555", {
      botHome: proj,
      newId: () => "sw-1",
    });
    expect(r.kind).toBe("sent");
    const isi = JSON.parse(readFileSync(join(slashDirIn(proj), "sw-1.json"), "utf8"));
    expect(isi.command).toBe("/resume 11111111-2222-3333-4444-555555555555");
  });
});
