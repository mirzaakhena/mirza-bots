/**
 * Bentuk satu pesan antar-bot, dan dua aturan yang membuat jalur ini tidak bisa
 * berputar.
 *
 * ATURAN 1 -- BALASAN TIDAK BOLEH MENUNTUT BALASAN. `expects_reply: true` hanya
 * sah bila `in_reply_to` tidak ada. Ini bukan sopan santun; ia yang membuat loop
 * A<->B MUSTAHIL alih-alih sekadar dibatasi. Dengan aturan ini, hop guard
 * kembali ke perannya yang benar: jaring pengaman untuk kasus tak terbayang,
 * bukan rem yang diinjak tiap hari.
 *
 * Bentuknya sengaja BOOLEAN, bukan enum tipe pesan. Usul awalnya
 * `ack-required`/`ack-response`; user menggantinya, dan alasannya bertahan:
 * tipe beranak (`notify`, `broadcast`, `fyi`…) dan tiap tipe baru memaksa
 * setiap guard diperbarui. Boolean tidak beranak.
 *
 * ATURAN 2 -- hop guard, dibawa dari `agent-bus`. Ia tidak ikut pindah dengan
 * sendirinya: `grep -i hop` atas seluruh cc-plugin dan cc-wrapper mengembalikan
 * NOL hasil (T-5). Ditolak DI SISI PENGIRIM supaya AI mendapat kalimat yang
 * menyuruhnya berhenti me-relay, bukan pesan yang hilang diam-diam di seberang.
 *
 * Keduanya divalidasi di KEDUA sisi. Pengirimnya bisa saja versi lama, atau
 * berkasnya ditulis tangan saat menguji. Aturan yang hanya dijaga satu sisi
 * bukan aturan.
 */
export const MAX_HOP = 5;
export const MAX_BODY_BYTES = 8 * 1024;

export type AgentMessage = {
  id: string;
  ts: string;
  from: string;
  text: string;
  expects_reply: boolean;
  in_reply_to?: string;
  hop_count: number;
};

export type SendCheck = { ok: true } | { ok: false; error: string };

export function validateOutgoing(msg: {
  text: string;
  expects_reply: boolean;
  in_reply_to?: string;
  hop_count: number;
}): SendCheck {
  if (typeof msg.text !== "string" || msg.text.length === 0) {
    return { ok: false, error: "text harus string tidak kosong" };
  }
  if (Buffer.byteLength(msg.text, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, error: `text melebihi ${MAX_BODY_BYTES} byte` };
  }
  if (!Number.isInteger(msg.hop_count) || msg.hop_count < 0) {
    return { ok: false, error: "hop_count harus bilangan bulat >= 0" };
  }
  if (msg.hop_count > MAX_HOP) {
    return {
      ok: false,
      error:
        `hop_count ${msg.hop_count} melewati batas ${MAX_HOP} -- menolak mengirim ` +
        `(anti-loop guard). Berhenti me-relay; lapor ke user-mu sendiri.`,
    };
  }
  if (msg.expects_reply && msg.in_reply_to !== undefined) {
    return {
      ok: false,
      error:
        "sebuah balasan tidak boleh menuntut balasan: expects_reply hanya sah " +
        "bila in_reply_to kosong. Kalau perlu percakapan lanjutan, mulai pesan baru.",
    };
  }
  return { ok: true };
}

export function parseAgentMessage(
  raw: string
): { ok: true; msg: AgentMessage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    // Buang BOM: berkas ber-BOM sudah menggigit proyek ini tiga kali (SCAR-026),
    // dan payload ini kadang ditulis tangan saat menguji.
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    return { ok: false, error: `JSON tidak bisa dibaca: ${err}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Array ditolak dengan sengaja: cc-wrapper menerima batch di `pending/`,
    // dan meniru bentuk itu di sini akan membuat dua pintu yang berbeda tampak
    // sama padahal tujuannya berbeda.
    return { ok: false, error: "payload harus objek" };
  }

  const o = parsed as Record<string, unknown>;
  for (const key of ["id", "ts", "from", "text"] as const) {
    const value = o[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `field ${key} harus string tidak kosong` };
    }
  }
  if (typeof o.expects_reply !== "boolean") {
    return { ok: false, error: "expects_reply harus boolean" };
  }
  if (o.in_reply_to !== undefined && typeof o.in_reply_to !== "string") {
    return { ok: false, error: "in_reply_to harus string bila ada" };
  }
  const hop = o.hop_count === undefined ? 0 : o.hop_count;
  if (typeof hop !== "number") {
    return { ok: false, error: "hop_count harus angka" };
  }

  const msg: AgentMessage = {
    id: o.id as string,
    ts: o.ts as string,
    from: o.from as string,
    text: o.text as string,
    expects_reply: o.expects_reply,
    hop_count: hop,
    ...(o.in_reply_to !== undefined ? { in_reply_to: o.in_reply_to as string } : {}),
  };

  const check = validateOutgoing(msg);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, msg };
}
