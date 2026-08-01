import { z } from "zod";
import { readFileSync } from "node:fs";
import { configPath } from "./paths";

export const BotConfigSchema = z.strictObject({
  home: z.string().min(1),
  token: z.string().min(1),
});

export const ConfigSchema = z.strictObject({
  allowFrom: z.array(z.string()),
  bots: z.record(z.string(), BotConfigSchema),
  // IANA zone name (e.g. "Asia/Jakarta"), used only to render ts_local alongside
  // the UTC ts we push. Deliberately NOT validated against the ICU zone list:
  // a typo here should cost the AI its local time, not stop the daemon booting.
  timezone: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function loadConfig(path: string = configPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${path}: ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`Config at ${path} failed validation: ${result.error.message}`);
  }
  return result.data;
}

export function botCount(config: Config): number {
  return Object.keys(config.bots).length;
}
