import { test, expect, describe } from "bun:test";
import { resolveChain } from "../../../src/engine/context/chain";

const BRIDGE = 'bun run "C:/plugins/cc-plugin/bin/statusline-bridge.ts"';

describe("resolveChain", () => {
  // INI bug sistem lama, ditulis sebagai kasus pertama supaya ia tidak bisa
  // lahir dua kali: installer lama hanya melihat lapisan project, padahal
  // statusline user tinggal di lapisan global. Hasilnya null, ditulis sebagai
  // string kosong, dan statusline user tergusur di enam dari enam bot.
  test("project kosong tapi user punya -> ambil punya USER", () => {
    expect(
      resolveChain(undefined, { type: "command", command: "statusline-progress.sh" }, BRIDGE)
    ).toEqual({ kind: "found", command: "statusline-progress.sh" });
  });

  // Meniru resolusi Claude Code, bukan selera: project menang atas user.
  test("project menang atas user kalau dua-duanya ada", () => {
    expect(resolveChain({ command: "project.sh" }, { command: "user.sh" }, BRIDGE)).toEqual({
      kind: "found",
      command: "project.sh",
    });
  });

  test("dua-duanya kosong -> none", () => {
    expect(resolveChain(undefined, undefined, BRIDGE)).toEqual({ kind: "none" });
  });

  // Tanpa ini, memasang dua kali membuat bridge memanggil DIRINYA SENDIRI:
  // rantai tak berujung yang tampil sebagai baris status yang membeku.
  test("yang terpasang sudah bridge -> already-bridge, bukan found", () => {
    expect(resolveChain({ command: BRIDGE }, { command: "user.sh" }, BRIDGE)).toEqual({
      kind: "already-bridge",
    });
  });

  test("bridge terpasang di lapisan user juga terdeteksi", () => {
    expect(resolveChain(undefined, { command: BRIDGE }, BRIDGE)).toEqual({
      kind: "already-bridge",
    });
  });

  test("bentuk yang tidak masuk akal diperlakukan sebagai tidak ada", () => {
    expect(resolveChain({ command: 42 }, null, BRIDGE)).toEqual({ kind: "none" });
    expect(resolveChain("bukan objek", undefined, BRIDGE)).toEqual({ kind: "none" });
    expect(resolveChain([], undefined, BRIDGE)).toEqual({ kind: "none" });
  });

  // String kosong PERSIS yang tertulis di keenam bot sistem lama. Ia harus
  // dibaca sebagai "tidak ada", bukan sebagai command bernama "".
  test("command kosong atau spasi bukan pendahulu yang sah", () => {
    expect(resolveChain({ command: "" }, undefined, BRIDGE)).toEqual({ kind: "none" });
    expect(resolveChain({ command: "   " }, undefined, BRIDGE)).toEqual({ kind: "none" });
  });

  // Project yang statusLine-nya tidak sah tidak boleh MENUTUPI punya user --
  // kalau tidak, bug lamanya lahir lagi lewat pintu berbeda.
  test("project tidak sah tapi user sah -> tetap ambil punya user", () => {
    expect(resolveChain({ command: "  " }, { command: "user.sh" }, BRIDGE)).toEqual({
      kind: "found",
      command: "user.sh",
    });
  });
});

describe("resolveChain -- bridge versi lain", () => {
  const LAMA = 'bun run "C:/Users/Mirza/.claude/plugins/cache/mirza-bots/cc-plugin/0.10.0/bin/statusline-bridge.ts"';
  const BARU = 'bun run "C:/Users/Mirza/.claude/plugins/cache/mirza-bots/cc-plugin/0.10.2/bin/statusline-bridge.ts"';

  // INI bug kedua, terukur hidup 2026-08-04. Perintah statusLine menyematkan
  // NOMOR VERSI di path-nya, dan versinya berubah tiap rilis. Perbandingan
  // string persis membuat bridge versi lama terbaca sebagai "statusline
  // pendahulu yang harus diselamatkan" -- lalu ia ditulis ke chained-statusline
  // dan statusline user yang asli HILANG, digantikan bridge memanggil bridge.
  test("bridge versi LAMA dikenali sebagai bridge, bukan sebagai pendahulu", () => {
    expect(resolveChain({ command: LAMA }, { command: "sl.sh" }, BARU)).toEqual({
      kind: "stale-bridge",
    });
  });

  test("bridge versi lama di lapisan user juga dikenali", () => {
    expect(resolveChain(undefined, { command: LAMA }, BARU)).toEqual({ kind: "stale-bridge" });
  });

  test("versi yang sama persis tetap already-bridge", () => {
    expect(resolveChain({ command: BARU }, undefined, BARU)).toEqual({ kind: "already-bridge" });
  });

  // Pagar terhadap kelewat longgar: statusline milik orang lain yang kebetulan
  // memuat kata "statusline" TIDAK boleh disangka bridge kita.
  test("statusline lain tidak disangka bridge", () => {
    expect(resolveChain({ command: "C:/x/my-statusline.sh" }, undefined, BARU)).toEqual({
      kind: "found",
      command: "C:/x/my-statusline.sh",
    });
    expect(
      resolveChain({ command: 'node "C:/x/statusline-bridge.js"' }, undefined, BARU)
    ).toEqual({ kind: "found", command: 'node "C:/x/statusline-bridge.js"' });
  });

  test("path bridge dengan backslash tetap dikenali", () => {
    const backslash =
      'bun run "C:\\Users\\Mirza\\.claude\\plugins\\cache\\mirza-bots\\cc-plugin\\0.9.0\\bin\\statusline-bridge.ts"';
    expect(resolveChain({ command: backslash }, undefined, BARU)).toEqual({
      kind: "stale-bridge",
    });
  });
});
