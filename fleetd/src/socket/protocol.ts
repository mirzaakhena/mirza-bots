export type DoctorRequest = { type: "doctor" };
export type HelloRequest = { type: "hello"; cwd: string };
export type ButtonRow = Array<{ text: string; data: string }>;
export type ReplyRequest = { type: "reply"; text: string; buttons?: ButtonRow[] };
export type Request = DoctorRequest | HelloRequest | ReplyRequest;

export type DoctorReport = {
  botCount: number;
  socketPath: string;
  fleetTables: string[];
  conversationsReady: boolean;
  version: string;
};

export type PushMessage = {
  type: "push_message";
  text: string;
  meta: Record<string, string>;
};

export type Response =
  | { ok: true; report: DoctorReport }
  | { ok: true; bot: string }
  | { ok: true }
  | { ok: false; error: string };

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

export function tryDecode(line: string): Request | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as Request;
    }
    return null;
  } catch {
    return null;
  }
}
