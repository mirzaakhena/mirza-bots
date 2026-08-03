import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlash, handleConfirm } from "../../../src/engine/slash";
import { pendingDir } from "../../../src/engine/slash/pending";

let proj: string;
let n = 0;
const deps = () => ({ projectDir: proj, newId: () => `id${++n}` });

beforeEach(() => { proj = mkdtempSync(join(tmpdir(), "slash-")); n = 0; });
afterEach(() => rmSync(proj, { recursive: true, force: true }));

function berkasPending(): string[] {
  try {
    return readdirSync(pendingDir(proj)).filter((f) => f.endsWith(".json"));
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
    const isi = JSON.parse(readFileSync(join(pendingDir(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual({ command: "/rename sesi-x" });
  });

  test("/new menulis batch dua perintah", () => {
    handleSlash("/new sesi-y", deps());
    const isi = JSON.parse(readFileSync(join(pendingDir(proj), berkasPending()[0]!), "utf8"));
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
    const isi = JSON.parse(readFileSync(join(pendingDir(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual({ command: "/compact" });
  });

  // Yang dikonfirmasi diteruskan apa adanya -- lapisan ini tidak mengolahnya,
  // dan tidak boleh diam-diam menerapkan pemetaan.
  test("command dikenal yang lewat jalur konfirmasi tidak dipetakan", () => {
    handleConfirm("/new x", deps());
    const isi = JSON.parse(readFileSync(join(pendingDir(proj), berkasPending()[0]!), "utf8"));
    expect(isi).toEqual({ command: "/new x" });
  });
});
