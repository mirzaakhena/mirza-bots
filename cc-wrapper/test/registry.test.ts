import { test, expect, describe } from "bun:test";
import { specFor, COMMAND_SPECS } from "../src/registry";

describe("specFor", () => {
  test("command tak terdaftar dapat spec kosong", () => {
    expect(specFor("/compact")).toEqual({});
    expect(specFor("/model opus")).toEqual({});
  });

  test("/effort dapat confirmAfterMs", () => {
    expect(specFor("/effort high").confirmAfterMs).toBe(500);
  });

  test("pencocokan hanya pada kata perintah, argumen diabaikan", () => {
    expect(specFor("/effort").confirmAfterMs).toBe(500);
    expect(specFor("/effort   low").confirmAfterMs).toBe(500);
  });

  test("pencocokan tidak peduli huruf besar-kecil", () => {
    expect(specFor("/EFFORT high").confirmAfterMs).toBe(500);
  });

  // Jebakan yang sama pernah dijaga eksplisit di slash-guards lama:
  // /effortless bukan /effort.
  test("command berawalan sama tidak ikut cocok", () => {
    expect(specFor("/effortless")).toEqual({});
  });

  test("registry hanya memuat command yang benar-benar butuh perlakuan", () => {
    expect(Object.keys(COMMAND_SPECS)).toEqual(["/effort"]);
  });
});
