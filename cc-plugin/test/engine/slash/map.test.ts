import { test, expect, describe } from "bun:test";
import { mapKnown } from "../../../src/engine/slash/map";

describe("mapKnown /rename", () => {
  test("jadi satu perintah slash CC", () => {
    const r = mapKnown("/rename", "sesi-baru");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ command: "/rename sesi-baru" });
  });

  test("nama tidak sah ditolak dengan pesannya", () => {
    const r = mapKnown("/rename", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("nama");
  });
});

describe("mapKnown /new", () => {
  // /new tidak ada di Claude Code -- ia inovasi lapisan Telegram, dan
  // terjemahannya adalah DUA perintah berurutan.
  test("jadi batch: /clear lalu /rename", () => {
    const r = mapKnown("/new", "sesi-baru");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual([
        { command: "/clear" },
        { command: "/rename sesi-baru" },
      ]);
    }
  });

  test("urutannya tidak boleh terbalik", () => {
    const r = mapKnown("/new", "x");
    if (r.ok && Array.isArray(r.payload)) {
      expect(r.payload[0]!.command).toBe("/clear");
    }
  });

  test("tanpa nama ditolak", () => {
    expect(mapKnown("/new", "").ok).toBe(false);
  });
});

describe("mapKnown", () => {
  test("command di luar daftar ditolak, bukan dilewatkan diam-diam", () => {
    const r = mapKnown("/tidak-ada", "x");
    expect(r.ok).toBe(false);
  });

  test("ack menyebut nama sesinya supaya user bisa memeriksa", () => {
    const r = mapKnown("/new", "sesi-baru");
    if (r.ok) expect(r.ack).toContain("sesi-baru");
  });
});
