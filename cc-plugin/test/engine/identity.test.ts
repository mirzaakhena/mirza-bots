import { expect, test } from "bun:test";
import { resolveBotByCwd } from "../../src/engine/identity";
import type { Config } from "../../src/engine/config";

const config: Config = {
  allowFrom: ["1"],
  bots: {
    "bot-01": { home: "C:\\Users\\Mirza\\workspace\\bot-01", token: "t1" },
    "bot-02": { home: "C:\\Users\\Mirza\\workspace\\bot-02", token: "t2" },
  },
};

test("resolves the bot whose home matches the cwd", () => {
  const res = resolveBotByCwd(config, "C:\\Users\\Mirza\\workspace\\bot-02");
  expect(res).toEqual({ ok: true, bot: "bot-02" });
});

// The whole point of W-16: an unknown cwd used to produce silence -- the socket
// rejected the hello, cc-plugin's top-level await threw, the process exited, and
// nothing reached the user at all. It must now produce a sentence a human can
// act on, and that sentence must name the alternatives: a refusal that does not
// teach the correct alternative gets answered with the same wrong attempt.
test("an unknown cwd explains itself and lists the registered bots", () => {
  const res = resolveBotByCwd(config, "C:\\Users\\Mirza\\workspace\\bot-99");

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message).toContain("bot-99");
  expect(res.message).toContain("bot-01");
  expect(res.message).toContain("bot-02");
});

test("an empty bots map still explains itself", () => {
  const res = resolveBotByCwd({ allowFrom: [], bots: {} }, "C:\\anywhere");

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected failure");
  expect(res.message).toContain("no bots");
});

// The message is read by a human staring at a bot that will not talk, so it has
// to say what to change, not merely what is wrong.
test("the failure message names the fix, not just the fault", () => {
  const res = resolveBotByCwd(config, "C:\\somewhere-else");

  if (res.ok) throw new Error("expected failure");
  expect(res.message).toContain("home");
  expect(res.message).toContain("config.json");
});
