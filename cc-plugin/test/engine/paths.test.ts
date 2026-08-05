import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBotHome,
  botNameFrom,
  configPathIn,
  conversationsDbPathIn,
  sessionIdPathIn,
  statusPathIn,
  chainedStatuslinePathIn,
  botPidPathIn,
  dataDirIn,
  inboxDirIn,
  slashDirIn,
  logsDirIn,
  ensureBotDirs,
} from "../../src/engine/paths";

const HOME = join("C:", "Users", "Mirza", "workspace", "mirza_01_bot");

describe("resolveBotHome", () => {
  test("memakai CLAUDE_PROJECT_DIR bila ada", () => {
    expect(resolveBotHome({ CLAUDE_PROJECT_DIR: HOME }, "C:\\lain")).toBe(HOME);
  });

  test("jatuh ke cwd bila env kosong", () => {
    expect(resolveBotHome({}, HOME)).toBe(HOME);
    expect(resolveBotHome({ CLAUDE_PROJECT_DIR: "   " }, HOME)).toBe(HOME);
  });
});

describe("botNameFrom", () => {
  test("nama bot adalah nama folder", () => {
    expect(botNameFrom(HOME)).toBe("mirza_01_bot");
  });

  test("separator dan trailing slash tidak mengubah nama", () => {
    expect(botNameFrom("C:/Users/Mirza/workspace/bot-02/")).toBe("bot-02");
    expect(botNameFrom("C:\\Users\\Mirza\\workspace\\bot-02\\")).toBe("bot-02");
  });
});

describe("path di dalam folder bot", () => {
  test("semuanya berpangkal pada folder bot, tanpa state root", () => {
    expect(configPathIn(HOME)).toBe(join(HOME, "config.json"));
    expect(conversationsDbPathIn(HOME)).toBe(join(HOME, "conversations.db"));
    expect(sessionIdPathIn(HOME)).toBe(join(HOME, "session.id"));
    expect(statusPathIn(HOME)).toBe(join(HOME, "status.json"));
    expect(chainedStatuslinePathIn(HOME)).toBe(join(HOME, "chained-statusline"));
    expect(botPidPathIn(HOME)).toBe(join(HOME, "bot.pid"));
    expect(dataDirIn(HOME)).toBe(join(HOME, "data"));
    expect(inboxDirIn(HOME)).toBe(join(HOME, "inbox"));
    expect(slashDirIn(HOME)).toBe(join(HOME, "slash"));
    expect(logsDirIn(HOME)).toBe(join(HOME, "logs"));
  });

  // Pagar terhadap kembalinya state terpusat lewat pintu belakang.
  test("tidak satu pun path menyeberang keluar dari folder bot", () => {
    for (const p of [
      configPathIn(HOME),
      conversationsDbPathIn(HOME),
      sessionIdPathIn(HOME),
      statusPathIn(HOME),
      chainedStatuslinePathIn(HOME),
      botPidPathIn(HOME),
      dataDirIn(HOME),
      inboxDirIn(HOME),
      slashDirIn(HOME),
      logsDirIn(HOME),
    ]) {
      expect(p.startsWith(HOME)).toBe(true);
    }
  });
});

describe("ensureBotDirs", () => {
  test("membuat data/, inbox/, dan logs/ -- dan tidak membuat state root apa pun", () => {
    const home = mkdtempSync(join(tmpdir(), "bothome-"));
    ensureBotDirs(home);
    expect(existsSync(dataDirIn(home))).toBe(true);
    expect(existsSync(inboxDirIn(home))).toBe(true);
    expect(existsSync(logsDirIn(home))).toBe(true);
  });
});

// slash/ dan inbox/ WAJIB dua folder berbeda. cc-wrapper menghapus berkas
// SEBELUM mem-parse-nya (main.ts: rmSync lalu parsePayload), jadi kalau
// keduanya berbagi folder, wrapper menghapus pesan antar-bot lalu menolaknya
// karena tidak ada field `command` -- pesan lenyap tanpa gejala.
describe("slash/ terpisah dari inbox/", () => {
  test("keduanya bukan folder yang sama", () => {
    expect(slashDirIn(HOME)).not.toBe(inboxDirIn(HOME));
  });
});

describe("ensureBotDirs membuat slash/", () => {
  test("bot baru punya slash/ sejak lahir, bukan sejak slash pertama dipakai", () => {
    const home = mkdtempSync(join(tmpdir(), "bothome-slash-"));
    ensureBotDirs(home);
    expect(existsSync(slashDirIn(home))).toBe(true);
  });
});
