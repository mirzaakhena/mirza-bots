import { test, expect, describe } from "bun:test";
import { botForCwd } from "../../../src/engine/context/bot-for-cwd";

const CONFIG = {
  bots: {
    "bot-uji": { home: "C:\\Users\\Mirza\\workspace\\bot-uji" },
    "bot-02": { home: "C:/Users/Mirza/workspace/bot-02" },
  },
};

describe("botForCwd", () => {
  test("cocok walau pemisah path berbeda", () => {
    expect(botForCwd(CONFIG, "C:/Users/Mirza/workspace/bot-uji")).toBe("bot-uji");
    expect(botForCwd(CONFIG, "C:\\Users\\Mirza\\workspace\\bot-02")).toBe("bot-02");
  });

  test("cocok walau ada garis miring di ujung", () => {
    expect(botForCwd(CONFIG, "C:\\Users\\Mirza\\workspace\\bot-02\\")).toBe("bot-02");
  });

  // Windows: path tidak peka huruf besar-kecil. Sesi CC bisa saja dibuka lewat
  // path dengan kapitalisasi berbeda dari yang tertulis di config.
  test("cocok walau beda besar-kecil huruf", () => {
    expect(botForCwd(CONFIG, "c:/users/mirza/workspace/bot-uji")).toBe("bot-uji");
  });

  // Folder yang bukan bot TIDAK boleh ditulis apa-apa. Bridge tetap meneruskan
  // ke statusline pendahulu -- jadi syarat spec §1 terpenuhi tanpa penanganan
  // khusus di tempat lain.
  test("folder yang bukan bot -> null", () => {
    expect(botForCwd(CONFIG, "C:/Users/Mirza/workspace/lain")).toBeNull();
  });

  test("bukan prefix: folder anak tidak dianggap bot induknya", () => {
    expect(botForCwd(CONFIG, "C:/Users/Mirza/workspace/bot-uji/sub")).toBeNull();
  });

  test("config tanpa bots -> null, bukan melempar", () => {
    expect(botForCwd({}, "C:/apa/saja")).toBeNull();
    expect(botForCwd(null, "C:/apa/saja")).toBeNull();
    expect(botForCwd({ bots: "bukan objek" }, "C:/apa/saja")).toBeNull();
  });

  test("entri tanpa home dilewati, tidak menjatuhkan yang lain", () => {
    const c = { bots: { rusak: {}, "bot-uji": { home: "C:/x/bot-uji" } } };
    expect(botForCwd(c, "C:/x/bot-uji")).toBe("bot-uji");
  });
});
