/**
 * Merender payload statusline yang tertangkap jadi teks balasan `/context`.
 *
 * MURNI, dan berkas ini wajib tetap nol-`import`: tidak ada I/O, tidak ada env,
 * tidak ada jam dinding. `nowMs` selalu datang dari pemanggil -- fungsi yang
 * diam-diam membaca `Date.now()` menghasilkan test yang berubah tiap kali
 * dijalankan, dan itu test yang tidak bisa dipercaya.
 *
 * Disalin dari sistem lama (`mirza-marketplace/plugins/telegram/
 * context-renderer.ts`), yang memang sudah nol-import sejak awal. Yang berubah
 * hanya nama dan hilangnya nilai default `Date.now()`.
 */

export type StatusLinePayload = {
  session_id?: string;
  cwd?: string;
  model?: { display_name?: string };
  context_window?: {
    used_percentage?: number;
    total_input_tokens?: number;
    context_window_size?: number;
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  cost?: { total_cost_usd?: number };
  thinking?: { enabled?: boolean };
  effort?: { level?: string };
  fast_mode?: boolean;
};

export type CapturedStatus = { captured_at_ms: number; payload: StatusLinePayload };

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  const millions = n / 1_000_000;
  return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
}

export function progressBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct * width) / 100)));
  return "●".repeat(filled) + "○".repeat(width - filled);
}

export function formatRelativeMs(ageMs: number): string {
  if (ageMs < 0) return "just now";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm ? `${hr}h ${rm}m ago` : `${hr}h ago`;
}

// Asia/Jakarta UTC+7 sepanjang tahun, tanpa DST -- dihitung langsung supaya
// tidak perlu Intl. Timezone-nya sengaja tetap hard-coded seperti sistem lama;
// membacanya dari config.json akan menuntut import dan mencabut kemurnian
// berkas ini demi satu-satunya zona yang dipakai proyek ini.
export function formatJakartaHM(epochMs: number): string {
  const d = new Date(epochMs + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} WIB`;
}

export function formatResetRemain(resetsAtSec: number, nowMs: number): string {
  // Pemanggil menambahkan kata "reset " di depan hasil ini -- jangan pernah
  // menuliskannya di sini atau jadi ganda ("reset reset just now").
  const remainSec = resetsAtSec - Math.floor(nowMs / 1000);
  if (remainSec <= 0) return "just now";
  const days = Math.floor(remainSec / 86400);
  const hours = Math.floor((remainSec % 86400) / 3600);
  const minutes = Math.floor((remainSec % 3600) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function shortCwd(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments.length < 2) return trimmed;
  return `…/${segments.slice(-2).join("/")}`;
}

export function shortSession(id: string): string {
  return id.slice(0, 8);
}

export interface RenderOptions {
  /** Bila diisi, menampilkan "Session: <nama> (<id pendek>)". */
  sessionName?: string | null;
}

export function renderContext(
  status: CapturedStatus,
  nowMs: number,
  opts: RenderOptions = {}
): string {
  const p = status.payload;
  const sections: string[] = [];

  // --- Context: selalu tampil; kalau datanya tidak ada, katakan begitu ---
  const ctxPct = p.context_window?.used_percentage;
  const ctxLines: string[] = ["Context"];
  if (typeof ctxPct === "number") {
    ctxLines.push(`${progressBar(ctxPct)} ${Math.round(ctxPct)}%`);
    const used = p.context_window?.total_input_tokens;
    const total = p.context_window?.context_window_size;
    if (typeof used === "number" && typeof total === "number") {
      ctxLines.push(`${formatTokens(used)} / ${formatTokens(total)} tokens`);
    }
  } else {
    ctxLines.push("(tidak tersedia)");
  }
  sections.push(ctxLines.join("\n"));

  // --- Rate limit: DIHILANGKAN kalau tidak ada, bukan ditulis 0%. Angka palsu
  //     lebih berbahaya daripada bagian yang absen. ---
  for (const [judul, rl] of [
    ["Rate Limit 5h", p.rate_limits?.five_hour],
    ["Rate Limit 7d", p.rate_limits?.seven_day],
  ] as const) {
    if (!rl) continue;
    if (typeof rl.used_percentage !== "number" && typeof rl.resets_at !== "number") continue;
    const lines = [judul];
    if (typeof rl.used_percentage === "number") {
      lines.push(`${progressBar(rl.used_percentage)} ${Math.round(rl.used_percentage)}%`);
    }
    if (typeof rl.resets_at === "number") {
      lines.push(`reset ${formatResetRemain(rl.resets_at, nowMs)}`);
    }
    sections.push(lines.join("\n"));
  }

  // --- Metadata: baris yang datanya tidak ada dilewati, bukan dikosongkan ---
  const meta: string[] = [];
  if (p.model?.display_name) meta.push(p.model.display_name);
  if (p.session_id) {
    const short = shortSession(p.session_id);
    meta.push(opts.sessionName ? `Session: ${opts.sessionName} (${short})` : `Session: ${short}`);
  }
  if (p.cwd) meta.push(`CWD: ${shortCwd(p.cwd)}`);
  if (typeof p.cost?.total_cost_usd === "number") {
    meta.push(`Cost: $${p.cost.total_cost_usd.toFixed(2)}`);
  }
  if (typeof p.thinking?.enabled === "boolean") {
    meta.push(`Thinking: ${p.thinking.enabled ? "on" : "off"}`);
  }
  if (typeof p.effort?.level === "string" && p.effort.level.length > 0) {
    meta.push(`Effort: ${p.effort.level}`);
  }
  if (typeof p.fast_mode === "boolean") {
    meta.push(`Fast: ${p.fast_mode ? "on" : "off"}`);
  }
  if (meta.length > 0) sections.push(meta.join("\n"));

  // --- Kapan terakhir ditangkap: selalu tampil, karena data ini BISA basi dan
  //     user berhak tahu seberapa. ---
  sections.push(
    `Last update: ${formatJakartaHM(status.captured_at_ms)}\n(${formatRelativeMs(nowMs - status.captured_at_ms)})`
  );

  return sections.join("\n\n");
}
