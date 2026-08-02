/**
 * Renders a UTC instant as a wall-clock timestamp in `timeZone`, e.g.
 * "2026-08-01T07:37:29+07:00".
 *
 * Storage stays UTC everywhere; this exists purely so the AI can tell 00:37 UTC
 * ("the user is up late" vs "the user just woke up") apart. The offset is kept in
 * the output because a bare local time is exactly the ambiguity we are fixing.
 *
 * Returns undefined rather than throwing: both an unknown zone (config typo) and
 * an unparseable instant raise RangeError, and neither is worth killing a poller
 * -- or losing the message -- over. The caller simply omits ts_local.
 */
export function formatLocalTimestamp(isoUtc: string, timeZone: string): string | undefined {
  try {
    const at = new Date(isoUtc);

    // hourCycle h23 rather than hour12:false: under hour12 some ICU builds render
    // midnight as hour "24", which would emit a timestamp no parser accepts.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    }).formatToParts(at);

    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";

    // "GMT+07:00" -> "+07:00"; plain "GMT" (a zero-offset zone) -> "+00:00", since
    // an empty suffix would read as a local time with no offset at all.
    const offset = get("timeZoneName").replace("GMT", "") || "+00:00";

    return (
      `${get("year")}-${get("month")}-${get("day")}` +
      `T${get("hour")}:${get("minute")}:${get("second")}${offset}`
    );
  } catch {
    return undefined;
  }
}
