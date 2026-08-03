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
