import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installBridge,
  buildBridgeCommand,
  pluginRootFrom,
  type InstallDeps,
} from "../../../src/engine/context/install";

const BRIDGE = 'bun run "C:/plugins/cc-plugin/bin/statusline-bridge.ts"';

function scratch(): InstallDeps & { projectSettings: string } {
  const root = mkdtempSync(join(tmpdir(), "install-"));
  const projectDir = join(root, "bot-uji");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  return {
    projectDir,
    userSettingsPath: join(root, "user-settings.json"),
    bridgeCommand: BRIDGE,
    chainPath: join(root, "state", "chained-statusline"),
    projectSettings: join(projectDir, ".claude", "settings.json"),
  };
}

describe("installBridge", () => {
  // Skenario PERSIS yang menggusur statusline user di sistem lama.
  test("project belum punya settings, user punya statusline -> rantai terisi punya user", () => {
    const s = scratch();
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));

    const r = installBridge(s);

    expect(r).toEqual({ kind: "installed", chained: "sl.sh" });
    expect(readFileSync(s.chainPath, "utf8")).toBe("sl.sh");
    expect(JSON.parse(readFileSync(s.projectSettings, "utf8")).statusLine.command).toBe(BRIDGE);
  });

  // PAGAR 3. Tidak tahu != tidak ada. Lebih baik /context mati daripada
  // statusline user mati.
  test("user settings TIDAK BISA DIBACA -> refused, settings project tidak disentuh", () => {
    const s = scratch();
    writeFileSync(s.userSettingsPath, "{ rusak json");

    const r = installBridge(s);

    expect(r.kind).toBe("refused");
    expect(existsSync(s.projectSettings)).toBe(false);
    expect(existsSync(s.chainPath)).toBe(false);
  });

  test("project settings rusak -> refused, tidak menimpa apa pun", () => {
    const s = scratch();
    writeFileSync(s.projectSettings, "{ rusak");
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));

    const r = installBridge(s);

    expect(r.kind).toBe("refused");
    expect(readFileSync(s.projectSettings, "utf8")).toBe("{ rusak");
  });

  test("setting lain di project settings tidak ikut hilang", () => {
    const s = scratch();
    writeFileSync(s.projectSettings, JSON.stringify({ env: { FOO: "bar" } }));
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));

    installBridge(s);

    const after = JSON.parse(readFileSync(s.projectSettings, "utf8"));
    expect(after.env).toEqual({ FOO: "bar" });
    expect(after.statusLine.command).toBe(BRIDGE);
  });

  test("memasang dua kali -> already-installed, rantai tidak menunjuk bridge sendiri", () => {
    const s = scratch();
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));
    installBridge(s);
    const r = installBridge(s);

    expect(r).toEqual({ kind: "already-installed" });
    expect(readFileSync(s.chainPath, "utf8")).toBe("sl.sh");
  });

  test("tidak ada statusline di mana pun -> tetap dipasang, rantai kosong", () => {
    const s = scratch();
    writeFileSync(s.userSettingsPath, JSON.stringify({}));

    expect(installBridge(s)).toEqual({ kind: "installed", chained: null });
    expect(readFileSync(s.chainPath, "utf8")).toBe("");
  });

  test("user settings belum ada sama sekali -> bukan refused, itu keadaan sah", () => {
    const s = scratch();
    expect(installBridge(s)).toEqual({ kind: "installed", chained: null });
  });

  // PAGAR 2: verifikasi SESUDAH menulis. Kegagalan disimulasikan lewat
  // penulisan yang gagal sekali -- di Windows ini bukan hipotetis: antivirus
  // dan indexer memang sesekali mengunci berkas yang baru dibuat.
  test("penulisan settings gagal -> rolled-back, isi lama kembali utuh", () => {
    const s = scratch();
    writeFileSync(s.projectSettings, JSON.stringify({ env: { FOO: "bar" } }));
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));
    const before = readFileSync(s.projectSettings, "utf8");

    let gagalkanSekali = true;
    const r = installBridge({
      ...s,
      writeFile: (path, data) => {
        if (gagalkanSekali && path.endsWith("settings.json")) {
          gagalkanSekali = false;
          throw new Error("EPERM: berkas terkunci");
        }
        writeFileSync(path, data);
      },
    });

    expect(r.kind).toBe("rolled-back");
    expect(readFileSync(s.projectSettings, "utf8")).toBe(before);
  });

  test("rollback menghapus settings yang tadinya belum ada", () => {
    const s = scratch();
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));

    let gagalkanSekali = true;
    const r = installBridge({
      ...s,
      writeFile: (path, data) => {
        if (gagalkanSekali && path.endsWith("settings.json")) {
          gagalkanSekali = false;
          throw new Error("EPERM");
        }
        writeFileSync(path, data);
      },
    });

    expect(r.kind).toBe("rolled-back");
    // Tadinya tidak ada; sesudah rollback harus tidak ada lagi. Meninggalkan
    // berkas kosong berarti project punya statusLine null -- dan itu justru
    // menggusur punya user, kegagalan yang sedang kita cegah.
    expect(existsSync(s.projectSettings)).toBe(false);
  });

  // Rantai yang tersimpan beda dari yang dimaksud = tidak boleh lanjut.
  // Menulis tanpa membaca ulang adalah niat, bukan jaminan.
  test("rantai tersimpan tidak sesuai -> rolled-back, settings tidak dipasang", () => {
    const s = scratch();
    writeFileSync(s.userSettingsPath, JSON.stringify({ statusLine: { command: "sl.sh" } }));

    const r = installBridge({
      ...s,
      writeFile: (path, data) => {
        // Rantai ditulis "berhasil" tapi isinya salah -- persis kegagalan
        // senyap yang tidak akan pernah terdeteksi tanpa baca ulang.
        writeFileSync(path, path === s.chainPath ? "" : data);
      },
    });

    expect(r.kind).toBe("rolled-back");
    expect(existsSync(s.projectSettings)).toBe(false);
  });
});

describe("buildBridgeCommand + pluginRootFrom", () => {
  test("perintah selalu forward slash, walau root-nya backslash Windows", () => {
    expect(buildBridgeCommand("C:\\plugins\\cc-plugin")).toBe(
      'bun run "C:/plugins/cc-plugin/bin/statusline-bridge.ts"'
    );
  });

  // resolveChain membandingkan perintah apa adanya untuk tahu apakah bridge
  // sudah terpasang. Bentuk yang berubah-ubah = bridge dipasang di atas dirinya.
  test("bentuknya stabil: trailing slash tidak mengubah hasil", () => {
    expect(buildBridgeCommand("C:/x/")).toBe(buildBridgeCommand("C:/x"));
  });

  test("env dipakai kalau ada", () => {
    expect(pluginRootFrom("C:/dari/env", "file:///C:/lain/src/engine/engine.ts")).toBe(
      "C:/dari/env"
    );
  });

  test("env kosong atau spasi diabaikan, jatuh ke URL modul", () => {
    expect(pluginRootFrom("   ", "file:///C:/x/y/src/engine/engine.ts")).toBe("C:/x/y");
    expect(pluginRootFrom(undefined, "file:///C:/x/y/src/engine/engine.ts")).toBe("C:/x/y");
  });

  test("path dengan spasi ter-decode benar", () => {
    expect(pluginRootFrom(undefined, "file:///C:/Program%20Files/p/src/engine/engine.ts")).toBe(
      "C:/Program Files/p"
    );
  });
});
