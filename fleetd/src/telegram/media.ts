import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Media download failed: ${res.status} ${res.statusText} (${url})`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await Bun.write(destPath, res);
}
