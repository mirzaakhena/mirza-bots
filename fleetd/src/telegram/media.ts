import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Telegram's file-download URLs carry the live bot token in the path
// (`/file/bot<token>/<file_path>`), so a raw URL must never reach a log line or
// an error message -- a single failed photo download would otherwise print the
// token to fleetd's stderr.
export function redactToken(url: string): string {
  return url.replace(/\/bot[^/]+\//, "/bot<redacted>/");
}

export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Media download failed: ${res.status} ${res.statusText} (${redactToken(url)})`
    );
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await Bun.write(destPath, res);
}
