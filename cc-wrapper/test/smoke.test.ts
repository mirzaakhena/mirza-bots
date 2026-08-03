import { test, expect } from "bun:test";
import { PACKAGE_NAME } from "../src/identity";

test("paket punya identitas", () => {
  expect(PACKAGE_NAME).toBe("cc-wrapper");
});
