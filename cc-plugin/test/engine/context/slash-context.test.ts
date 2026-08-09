import { test, expect, describe } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, KNOWN_COMMANDS } from "../../../src/engine/slash/classify";
import { COMMAND_DESCRIPTIONS, buildCommandMenu } from "../../../src/engine/slash/menu";
import { handleSlash } from "../../../src/engine/slash";
import { renderContext } from "../../../src/engine/context/render";
import { slashDirIn } from "../../../src/engine/paths";

describe("/context di lapisan slash", () => {
  test("dikenal, bukan lewat jalur konfirmasi", () => {
    expect(classify("/context")).toEqual({ kind: "known", name: "/context", arg: "" });
  });

  test("masuk KNOWN_COMMANDS dan punya deskripsi menu", () => {
    expect(KNOWN_COMMANDS).toContain("/context");
    expect(COMMAND_DESCRIPTIONS["/context"]).toBeTruthy();
    expect(buildCommandMenu().some((e) => e.command === "context")).toBe(true);
  });

  // Inti keputusan spec tahap 1 §4: /context TIDAK PERNAH sampai ke Claude
  // Code. Ia dijawab dari data lokal.
  test("TIDAK menulis pending -- tidak pernah dikirim ke CC", () => {
    const dir = mkdtempSync(join(tmpdir(), "slash-ctx-"));
    const out = handleSlash("/context", { botHome: dir, newId: () => "id-1", sessionTitles: () => [] });

    expect(out).toEqual({ kind: "local", command: "/context" });

    // Dua meteran: outcome-nya benar DAN tidak ada payload yang lahir. Yang
    // pertama saja tidak membedakan "tidak dikirim" dari "dikirim diam-diam".
    const pending = slashDirIn(dir);
    expect(existsSync(pending) ? readdirSync(pending) : []).toHaveLength(0);
  });

  test("argumen diabaikan, tetap local", () => {
    const dir = mkdtempSync(join(tmpdir(), "slash-ctx-"));
    expect(handleSlash("/context apa saja", { botHome: dir, newId: () => "x", sessionTitles: () => [] })).toEqual({
      kind: "local",
      command: "/context",
    });
  });

  test("/rename masih menulis pending -- jalur command lain tidak ikut berubah", () => {
    const dir = mkdtempSync(join(tmpdir(), "slash-ctx-"));
    const out = handleSlash("/rename halo", { botHome: dir, newId: () => "id-2", sessionTitles: () => [] });
    expect(out.kind).toBe("sent");
    expect(readdirSync(slashDirIn(dir))).toHaveLength(1);
  });
});

describe("nama sesi dari payload statusline", () => {
  // Terukur dari last-status.json nyata: payload statusline Claude Code SUDAH
  // memuat session_name. Jadi /context tidak butuh registri nama sesi -- itu
  // kebutuhan /switch, dan cakupannya terpisah.
  test("session_name di payload dipakai tanpa perlu registri", () => {
    const out = renderContext(
      {
        captured_at_ms: 1785784649346,
        payload: { session_id: "65eb550e-31f4", session_name: "task-lapisan-slash" },
      },
      1785784649346
    );
    expect(out).toContain("task-lapisan-slash");
  });

  test("opts.sessionName menang atas payload kalau keduanya ada", () => {
    const out = renderContext(
      {
        captured_at_ms: 1785784649346,
        payload: { session_id: "65eb550e-31f4", session_name: "dari-payload" },
      },
      1785784649346,
      { sessionName: "dari-pemanggil" }
    );
    expect(out).toContain("dari-pemanggil");
    expect(out).not.toContain("dari-payload");
  });
});
