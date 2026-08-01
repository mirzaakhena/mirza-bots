#!/usr/bin/env bun
/**
 * Stop hook: block once when a channel-driven conversation is about to end with
 * no `reply` sent since the newest inbound message.
 *
 * Why this exists at all: the person who sent that message is reading Telegram,
 * not this transcript. If the turn ends without a `reply` tool call, they get
 * nothing -- no error, no hint, just silence they cannot distinguish from a
 * broken bot. That silence is the most expensive failure class in this project.
 *
 * Why it is urgent NOW: the terse-turn protocol trains the AI to close a turn
 * with a bare ".". That makes "answered, then closed" and "forgot to answer,
 * then closed" look identical from the outside. The protocol raised the odds of
 * exactly this failure, so it needs a machine guarding it rather than the AI
 * remembering.
 */
import { readFileSync } from "node:fs";
import { TERSE_TURN_MARKER } from "../src/server";

const REPLY_TOOL = "mcp__plugin_cc-plugin_cc-plugin__reply";

export interface TranscriptAnalysis {
  channelDriven: boolean;
  latestInboundIdx: number;
  latestReplyIdx: number;
}

/**
 * Pulls the readable text out of a transcript entry regardless of its shape.
 *
 * Load bearing: an inbound channel message arrives with `message.content` as a
 * plain STRING, while an assistant turn carries an ARRAY of parts. The old
 * system's guard tested `Array.isArray(content)` and returned early otherwise --
 * porting that check verbatim would have made this hook see no inbound at all.
 * Installed, running, and silently guarding nothing.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

export function analyzeTranscript(lines: string[]): TranscriptAnalysis {
  let channelDriven = false;
  let latestInboundIdx = -1;
  let latestReplyIdx = -1;

  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // A malformed line is not worth losing the whole guard over.
      return;
    }

    if (obj?.type === "user") {
      // Two independent signals, either is enough. `origin` is what Claude Code
      // records for a channel-delivered prompt; the marker is our own stamp on
      // every push. Accepting either means neither one going away silently
      // disarms the guard.
      const viaOrigin = obj?.origin?.kind === "channel";
      const viaMarker = textOf(obj?.message?.content).includes(TERSE_TURN_MARKER);
      if (viaOrigin || viaMarker) {
        channelDriven = true;
        latestInboundIdx = idx;
      }
      return;
    }

    if (obj?.type === "assistant") {
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part?.type === "tool_use" && part.name === REPLY_TOOL) latestReplyIdx = idx;
      }
    }
  });

  return { channelDriven, latestInboundIdx, latestReplyIdx };
}

export function decideStop(
  a: TranscriptAnalysis,
  stopHookActive: boolean
): { block: boolean; reason?: string } {
  // Claude Code telling us we already blocked once. Blocking again would trap
  // the session in a loop it has no way out of.
  if (stopHookActive) return { block: false };
  if (!a.channelDriven || a.latestInboundIdx === -1) return { block: false };
  // Positions, not a boolean: answering the first message and then going quiet
  // on the second is the exact failure worth catching.
  if (a.latestReplyIdx > a.latestInboundIdx) return { block: false };

  return {
    block: true,
    reason:
      "This message came from Telegram and the person who sent it is AFK -- they do not see this " +
      "transcript. You have not sent a reply since their last message. Send your answer now via " +
      `the \`reply\` tool (${REPLY_TOOL}), then end the turn.`,
  };
}

/**
 * Parses the hook payload, tolerating a leading UTF-8 BOM.
 *
 * The BOM matters more than it looks: with one in front, JSON.parse throws,
 * main() returns early, and the guard does nothing at all -- while remaining
 * perfectly installed and enabled. A hook whose whole purpose is "never fail
 * silently" must not be silently disarmed by one invisible character. Third BOM
 * incident in this project (SCAR-026).
 *
 * Returns null rather than throwing, so a genuinely malformed payload cannot
 * take the hook down either.
 */
export function parseHookInput(raw: string): any | null {
  try {
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const input = parseHookInput(raw);
  if (input === null) return;
  if (input?.stop_hook_active === true) return;

  const path = input?.transcript_path;
  if (typeof path !== "string") return;

  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return;
  }

  const decision = decideStop(analyzeTranscript(lines), false);
  if (!decision.block) return;
  process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
}

if (import.meta.main) main();
