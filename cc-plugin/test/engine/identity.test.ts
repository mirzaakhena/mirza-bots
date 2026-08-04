import { test, expect, describe } from "bun:test";
import { identifyBot } from "../../src/engine/identity";

const HOME = "C:\\Users\\Mirza\\workspace\\mirza_01_bot";

describe("identifyBot", () => {
  test("folder dengan config.json adalah bot, dan namanya nama folder", () => {
    const res = identifyBot(HOME, true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bot).toBe("mirza_01_bot");
  });

  test("folder tanpa config.json bukan bot", () => {
    const res = identifyBot(HOME, false);
    expect(res.ok).toBe(false);
  });

  // W-16: kegagalan harus berupa kalimat yang mengajari, bukan null. Penolakan
  // yang tidak menyebutkan alternatif yang benar dijawab dengan percobaan salah
  // yang sama.
  test("pesan gagal menyebut foldernya DAN cara memperbaikinya", () => {
    const res = identifyBot(HOME, false);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain(HOME);
      expect(res.message).toContain("config.json");
      expect(res.message).toContain("token");
    }
  });
});
