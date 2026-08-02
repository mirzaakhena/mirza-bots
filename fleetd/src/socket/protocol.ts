import { z } from "zod";

// fleetd is the single point of validation for the whole fleet: every request
// crossing the socket boundary is parsed by these schemas, never blind-cast.
// Without this a malformed request (e.g. `buttons` as a string) reached deep
// into main.ts and threw from InlineKeyboard construction.
export const ButtonSchema = z.strictObject({ text: z.string(), data: z.string() });
export const ButtonRowSchema = z.array(ButtonSchema);

export const DoctorRequestSchema = z.strictObject({ type: z.literal("doctor") });
export const HelloRequestSchema = z.strictObject({
  type: z.literal("hello"),
  cwd: z.string(),
  // Optional on purpose: a plugin that cannot determine its session id must
  // still be able to connect. The column then stays NULL rather than the
  // handshake failing.
  sessionId: z.string().optional(),
});
export const ReplyRequestSchema = z.strictObject({
  type: z.literal("reply"),
  text: z.string(),
  buttons: z.array(ButtonRowSchema).optional(),
});

export const HistoryRequestSchema = z.strictObject({
  type: z.literal("history"),
  messageId: z.string().min(1),
  before: z.number().int().min(0).max(50).optional(),
  after: z.number().int().min(0).max(50).optional(),
  // Absent means "the calling bot". Naming another bot is the explicit,
  // deliberate act K-3 requires for crossing that boundary.
  bot: z.string().min(1).optional(),
});

export const SearchRequestSchema = z.strictObject({
  type: z.literal("search"),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  bot: z.string().min(1).optional(),
});

export const RequestSchema = z.discriminatedUnion("type", [
  DoctorRequestSchema,
  HelloRequestSchema,
  ReplyRequestSchema,
  HistoryRequestSchema,
  SearchRequestSchema,
]);

// Types are inferred from the schemas rather than hand-written, so the runtime
// contract and the compile-time contract can never drift apart.
export type ButtonRow = z.infer<typeof ButtonRowSchema>;
export type DoctorRequest = z.infer<typeof DoctorRequestSchema>;
export type HelloRequest = z.infer<typeof HelloRequestSchema>;
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type Request = z.infer<typeof RequestSchema>;

// TEMPORARY re-export: these shapes now live in the engine, which outlives the
// socket. Declared in one place only (K-15); this file disappears in Task 6.
export type { HistoryMessage, DoctorReport } from "../../../cc-plugin/src/engine/types";

export type PushMessage = {
  type: "push_message";
  text: string;
  meta: Record<string, string>;
};

export type Response =
  | { ok: true; report: DoctorReport }
  | { ok: true; bot: string }
  | { ok: true; messages: HistoryMessage[] }
  | { ok: true }
  | { ok: false; error: string };

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

// Returns null for anything that is not a valid request -- unparseable JSON, an
// unknown `type`, or a known type with missing/wrong-typed fields. The socket
// server turns that single null into its existing `bad_request` response, so a
// malformed request is answered instead of being handed to a handler that would
// throw on it.
export function tryDecode(line: string): Request | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const result = RequestSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
