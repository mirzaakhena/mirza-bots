import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePending, pendingDir } from "../../../src/engine/slash/pending";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pending-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pendingDir", () => {
  test("mengikuti letak yang dibaca wrapper", () => {
    expect(pendingDir("C:/proyek").split(/[\\/]/).slice(-4)).toEqual([
      ".claude", "channels", "pty-controller", "pending",
    ]);
  });
});

describe("writePending", () => {
  test("menulis satu berkas .json berisi payload", () => {
    writePending(dir, { command: "/rename x" }, "abc");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toEqual(["abc.json"]);
    expect(JSON.parse(readFileSync(join(dir, "abc.json"), "utf8"))).toEqual({
      command: "/rename x",
    });
  });

  test("payload batch ditulis sebagai array", () => {
    writePending(dir, [{ command: "/clear" }, { command: "/rename x" }], "b1");
    const isi = JSON.parse(readFileSync(join(dir, "b1.json"), "utf8"));
    expect(Array.isArray(isi)).toBe(true);
    expect(isi).toHaveLength(2);
  });

  // Wrapper membaca folder ini dengan polling; berkas setengah tertulis akan
  // ditolak sebagai JSON rusak. Tulis .tmp lalu rename.
  test("tidak meninggalkan berkas .tmp", () => {
    writePending(dir, { command: "/clear" }, "c1");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("folder yang belum ada dibuat", () => {
    const dalam = join(dir, "belum", "ada");
    writePending(dalam, { command: "/clear" }, "d1");
    expect(readdirSync(dalam)).toEqual(["d1.json"]);
  });
});
