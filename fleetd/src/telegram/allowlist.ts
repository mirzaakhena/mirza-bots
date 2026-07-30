import type { Config } from "../config";

export function isAllowed(config: Config, chatId: string): boolean {
  return config.allowFrom.includes(chatId);
}
