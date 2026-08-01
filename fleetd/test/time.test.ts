import { describe, test, expect } from "bun:test";
import { formatLocalTimestamp } from "../src/time";

describe("formatLocalTimestamp", () => {
  test("renders a UTC instant in a zone ahead of UTC, with its offset", () => {
    expect(formatLocalTimestamp("2026-08-01T00:37:29.000Z", "Asia/Jakarta")).toBe(
      "2026-08-01T07:37:29+07:00"
    );
  });

  test("renders a UTC instant in a zone behind UTC, rolling the date back", () => {
    // The whole point of the feature: 03:00 UTC is still the previous evening in
    // New York, and "same day" is exactly what the AI gets wrong without this.
    expect(formatLocalTimestamp("2026-08-01T03:00:00.000Z", "America/New_York")).toBe(
      "2026-07-31T23:00:00-04:00"
    );
  });

  test("keeps midnight as 00, not 24", () => {
    // Some ICU builds render hour 0 as "24" under hour12:false; h23 is what stops
    // "2026-08-01T24:30:00" reaching the AI as a timestamp no parser accepts.
    expect(formatLocalTimestamp("2026-07-31T17:30:00.000Z", "Asia/Jakarta")).toBe(
      "2026-08-01T00:30:00+07:00"
    );
  });

  test("renders UTC itself with an explicit +00:00 rather than a bare offset", () => {
    expect(formatLocalTimestamp("2026-08-01T00:37:29.000Z", "UTC")).toBe(
      "2026-08-01T00:37:29+00:00"
    );
  });

  test("returns undefined instead of throwing on an unknown zone", () => {
    // A typo in config must cost the user their ts_local, not the poller.
    expect(formatLocalTimestamp("2026-08-01T00:37:29.000Z", "Mars/Olympus_Mons")).toBeUndefined();
  });

  test("returns undefined instead of throwing on an unparseable timestamp", () => {
    expect(formatLocalTimestamp("not a timestamp", "Asia/Jakarta")).toBeUndefined();
  });

  test("returns undefined for an empty zone", () => {
    expect(formatLocalTimestamp("2026-08-01T00:37:29.000Z", "")).toBeUndefined();
  });
});
