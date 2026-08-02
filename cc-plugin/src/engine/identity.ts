import type { Config } from "./config";

export type IdentityResult = { ok: true; bot: string } | { ok: false; message: string };

/**
 * Answers "which bot am I?" from the session's project directory.
 *
 * Returns a sentence rather than null on failure, and that difference IS the fix
 * for W-16. The old path rejected an unknown cwd over the socket, cc-plugin's
 * top-level `await connect()` threw, the process exited, and nothing reached the
 * user at all -- the plugin was simply not there. Roughly two hours went into
 * chasing that on 2026-08-01, and the root cause was never found, because a
 * process that dies before it can speak leaves nothing to find.
 *
 * The message names the registered bots and the fix, not just the fault: a
 * refusal that does not teach the correct alternative gets answered with the
 * same wrong attempt.
 */
export function resolveBotByCwd(config: Config, cwd: string): IdentityResult {
  for (const [name, bot] of Object.entries(config.bots)) {
    if (bot.home === cwd) return { ok: true, bot: name };
  }

  const names = Object.keys(config.bots);
  const known =
    names.length === 0
      ? "no bots are registered in config.json at all"
      : `registered bots: ${names.join(", ")}`;

  return {
    ok: false,
    message:
      `This directory (${cwd}) is not the home of any bot in config.json, so this ` +
      `session has no Telegram identity and will not poll. ${known}. To fix it, add ` +
      `an entry to config.json whose "home" is exactly this path, then restart the ` +
      `session.`,
  };
}
