import { test, expect, describe } from "bun:test";
import { planCommand, chunkText, SUBMIT_DELAY_MS } from "../src/typer";

describe("chunkText", () => {
  test("teks pendek jadi satu potong", () => {
    expect(chunkText("halo", 100)).toEqual(["halo"]);
  });

  test("teks panjang dipotong sesuai ukuran", () => {
    const text = "a".repeat(250);
    const parts = chunkText(text, 100);
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe(text);
  });

  // Pemotongan pada code point, bukan UTF-16: satu emoji di batas potongan
  // tidak boleh terbelah jadi surrogate pair yang rusak.
  test("emoji tidak terbelah di batas potongan", () => {
    const text = "ab🎉cd";
    const parts = chunkText(text, 3);
    expect(parts.join("")).toBe(text);
    expect(parts[0]).toBe("ab🎉");
  });
});

describe("planCommand", () => {
  test("command biasa: ketik, jeda, Enter", () => {
    const steps = planCommand("/compact");
    expect(steps).toEqual([
      { text: "/compact", delayAfterMs: SUBMIT_DELAY_MS },
      { text: "\r", delayAfterMs: 0 },
    ]);
  });

  test("confirmAfterMs menambah Enter kedua", () => {
    const steps = planCommand("/effort high", { confirmAfterMs: 500 });
    expect(steps).toEqual([
      { text: "/effort high", delayAfterMs: SUBMIT_DELAY_MS },
      { text: "\r", delayAfterMs: 500 },
      { text: "\r", delayAfterMs: 0 },
    ]);
  });

  test("command panjang dipotong sebelum Enter", () => {
    const long = "/rename " + "x".repeat(150);
    const steps = planCommand(long);
    // 158 karakter -> 2 potong, lalu Enter
    expect(steps.length).toBe(3);
    expect(steps[steps.length - 1]!.text).toBe("\r");
    expect(steps.slice(0, -1).map((s) => s.text).join("")).toBe(long);
  });
});
