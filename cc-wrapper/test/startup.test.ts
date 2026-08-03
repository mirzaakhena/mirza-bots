import { test, expect, describe } from "bun:test";
import {
  CONTINUE_FLAG,
  firstAttemptArgs,
  retryArgs,
  looksLikeNoConversation,
  looksLikeTrustGate,
  shouldRetryWithoutContinue,
} from "../src/startup";

describe("penyusunan argumen", () => {
  test("percobaan pertama menambahkan --continue di depan", () => {
    expect(firstAttemptArgs(["--dangerously-skip-permissions"])).toEqual([
      CONTINUE_FLAG,
      "--dangerously-skip-permissions",
    ]);
  });

  test("percobaan ulang membuang --continue, sisanya utuh", () => {
    expect(retryArgs(["--a", "--b", "nilai"])).toEqual(["--a", "--b", "nilai"]);
  });

  test("user yang sudah menulis --continue sendiri tidak digandakan", () => {
    expect(firstAttemptArgs(["--continue", "--x"])).toEqual([CONTINUE_FLAG, "--x"]);
  });

  test("user yang menulis -c juga tidak digandakan", () => {
    expect(firstAttemptArgs(["-c"])).toEqual(["-c"]);
  });
});

describe("looksLikeNoConversation", () => {
  test("mengenali pesan CC apa adanya", () => {
    expect(looksLikeNoConversation("No conversation found to continue")).toBe(true);
  });

  // Keluaran TUI datang tanpa spasi karena render kolom: probe menangkap
  // "Quicksafetycheck:Isthisaproject…". Deteksi harus tahan terhadap itu.
  test("mengenali walau spasinya hilang", () => {
    expect(looksLikeNoConversation("…[<uNoconversationfoundtocontinue…")).toBe(true);
  });

  test("tidak salah kenali teks lain", () => {
    expect(looksLikeNoConversation("Welcome back! Tips for getting started")).toBe(false);
  });
});

describe("looksLikeTrustGate", () => {
  test("mengenali gerbang dari keluaran nyata probe", () => {
    const nyata =
      "Accessingworkspace:C:\\folderQuicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?" +
      "❯1.Yes,Itrustthisfolder2.No,exitEntertoconfirm·Esctocancel";
    expect(looksLikeTrustGate(nyata)).toBe(true);
  });

  test("mengenali bentuk berspasi juga", () => {
    expect(looksLikeTrustGate("Quick safety check: Is this a project you created")).toBe(true);
  });

  test("sesi normal tidak dikira gerbang", () => {
    expect(looksLikeTrustGate("Claude Code v2.1.220 Welcome back!")).toBe(false);
  });
});

describe("shouldRetryWithoutContinue", () => {
  test("keluar cepat + pesan no-conversation → ulangi", () => {
    expect(
      shouldRetryWithoutContinue({
        exited: true,
        elapsedMs: 1200,
        output: "No conversation found to continue",
      })
    ).toBe(true);
  });

  test("keluar cepat tanpa pesan itu → JANGAN ulangi", () => {
    // Kegagalan lain (binary hilang, folder tidak ada) tidak boleh disembunyikan
    // di balik percobaan ulang yang kelihatan berhasil.
    expect(
      shouldRetryWithoutContinue({ exited: true, elapsedMs: 800, output: "command not found" })
    ).toBe(false);
  });

  test("masih hidup → jangan ulangi walau pesannya kebetulan ada", () => {
    expect(
      shouldRetryWithoutContinue({
        exited: false,
        elapsedMs: 500,
        output: "No conversation found to continue",
      })
    ).toBe(false);
  });

  // Sesi yang sudah berjalan lama lalu user mengetik /exit juga "keluar".
  // Mengulanginya berarti menghidupkan lagi sesi yang sengaja ditutup.
  test("keluar setelah lama → jangan ulangi", () => {
    expect(
      shouldRetryWithoutContinue({
        exited: true,
        elapsedMs: 60_000,
        output: "No conversation found to continue",
      })
    ).toBe(false);
  });
});
