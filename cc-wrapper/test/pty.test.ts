import { test, expect, describe } from "bun:test";
import { runPlan, childEnv } from "../src/pty";
import { planCommand, SUBMIT_DELAY_MS } from "../src/typer";

describe("runPlan", () => {
  test("menulis tiap potongan berurutan dan menunggu sesuai rencana", async () => {
    const written: string[] = [];
    const slept: number[] = [];
    await runPlan(
      (s) => {
        written.push(s);
      },
      planCommand("/compact"),
      async (ms) => {
        slept.push(ms);
      }
    );
    expect(written).toEqual(["/compact", "\r"]);
    expect(slept).toEqual([SUBMIT_DELAY_MS, 0]);
  });

  test("Enter kedua ikut tertulis untuk command berkonfirmasi", async () => {
    const written: string[] = [];
    await runPlan(
      (s) => {
        written.push(s);
      },
      planCommand("/effort high", { confirmAfterMs: 500 }),
      async () => {}
    );
    expect(written).toEqual(["/effort high", "\r", "\r"]);
  });
});

describe("childEnv", () => {
  // Task 0: sesi anak yang mewarisi penanda ini TIDAK menyimpan transcript,
  // dan transcript adalah sumber bukti untuk post-check di Lapis 3.
  test("membuang CLAUDE_CODE_CHILD_SESSION", () => {
    const env = childEnv({ PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1" });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  test("membuang nilai undefined", () => {
    const env = childEnv({ A: "1", B: undefined });
    expect(env).toEqual({ A: "1" });
  });
});
