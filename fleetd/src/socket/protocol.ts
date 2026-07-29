export type DoctorRequest = { type: "doctor" };
export type Request = DoctorRequest;

export type DoctorReport = {
  botCount: number;
  socketPath: string;
  fleetTables: string[];
  conversationsReady: boolean;
  version: string;
};

export type Response = { ok: true; report: DoctorReport } | { ok: false; error: string };

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
