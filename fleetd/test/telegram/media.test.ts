import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadToFile } from "../../src/telegram/media";

let tmp: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("downloadToFile", () => {
  test("downloads bytes to a nested path, creating directories as needed", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { "content-type": "image/jpeg" } }),
    });
    tmp = mkdtempSync(join(tmpdir(), "media-test-"));
    const dest = join(tmp, "inbox", "bot-01", "photo1.jpg");

    await downloadToFile(`http://localhost:${server.port}/photo.jpg`, dest);

    expect([...readFileSync(dest)]).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects on a non-2xx response instead of writing a partial/empty file", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
    tmp = mkdtempSync(join(tmpdir(), "media-test-"));
    const dest = join(tmp, "missing.jpg");

    await expect(downloadToFile(`http://localhost:${server.port}/missing.jpg`, dest)).rejects.toThrow();
  });
});
