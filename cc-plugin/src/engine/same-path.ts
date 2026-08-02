/**
 * Do these two strings name the same directory?
 *
 * Exists because they very often do not *look* like it. Measured 2026-08-02:
 * Claude Code hands the SessionStart hook `C:/Users/Mirza/workspace/bot-uji`
 * while `config.json` holds `C:\Users\Mirza\workspace\bot-uji` -- the same
 * directory, spelled two ways, compared with `===`, matching never.
 *
 * That mismatch made a hook that fired every single time look like a hook that
 * never fired at all, and cost a round of debugging chasing the wrong cause.
 *
 * Deliberately NOT using path.resolve(): these strings come from another
 * machine's idea of the filesystem, not from this process's cwd, and resolving
 * them against our own working directory would invent an answer for anything
 * relative. Comparing spellings is exactly the job.
 *
 * What is normalised, and why each is safe:
 *  - separators: `\` and `/` are interchangeable on Windows, and a POSIX path
 *    never contains `\` as a separator, so folding them cannot merge two
 *    genuinely different paths.
 *  - trailing separator: `/a/b` and `/a/b/` are the same directory.
 *
 * What is NOT normalised: case. Windows is case-insensitive and Linux is not,
 * and folding case here would risk answering "same" for two different
 * directories on the platform where that is possible. A wrong match is worse
 * than a missed one -- a missed one is visible in the logs.
 */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

export function normalizePath(p: string): string {
  const withSlashes = p.replace(/\\/g, "/");
  // A root keeps its trailing separator: "/" and "C:/" ARE the directory, and
  // trimming them leaves "" and "C:" -- the second of which means "the current
  // directory on drive C", a different place entirely.
  if (/^\/$/.test(withSlashes) || /^[A-Za-z]:\/$/.test(withSlashes)) return withSlashes;
  return withSlashes.endsWith("/") ? withSlashes.slice(0, -1) : withSlashes;
}
