import { test, expect, describe } from "bun:test";
import { planChainInvocation } from "../../../src/engine/context/invoke";

describe("planChainInvocation", () => {
  // INI bugnya. Di Windows, ekstensi .sh terasosiasi ke
  //   sh_auto_file = "C:\Program Files\Git\git-bash.exe" --no-cd "%L" %*
  // jadi menyerahkannya ke shell TIDAK menjalankan skripnya -- ia MEMBUKA
  // jendela Git Bash baru, dan spawnSync menunggu jendela itu ditutup.
  // Terukur 2026-08-04: percobaan langsung menggantung sampai timeout 2 menit.
  test("skrip .sh dijalankan lewat bash, bukan diserahkan ke asosiasi Windows", () => {
    const p = planChainInvocation("C:/Users/Mirza/.claude/statusline-progress.sh");
    expect(p.command).toBe('bash "C:/Users/Mirza/.claude/statusline-progress.sh"');
    expect(p.shell).toBe(true);
  });

  test("path .sh yang sudah berkutip tidak jadi berkutip ganda", () => {
    const p = planChainInvocation('"C:/Program Files/x/sl.sh"');
    expect(p.command).toBe('bash "C:/Program Files/x/sl.sh"');
  });

  test("argumen sesudah .sh ikut diteruskan", () => {
    const p = planChainInvocation('"C:/x/sl.sh" --compact');
    expect(p.command).toBe('bash "C:/x/sl.sh" --compact');
  });

  test("huruf besar .SH tetap terdeteksi", () => {
    expect(planChainInvocation("C:/x/SL.SH").command).toBe('bash "C:/x/SL.SH"');
  });

  // Yang BUKAN .sh dibiarkan apa adanya: statusline orang lain bisa berupa
  // .exe, .cmd, atau baris perintah utuh, dan mengarangnya ulang justru
  // merusak yang tadinya bekerja.
  test("perintah non-.sh diteruskan apa adanya", () => {
    const p = planChainInvocation('node "C:/x/statusline.js" --flag');
    expect(p.command).toBe('node "C:/x/statusline.js" --flag');
    expect(p.shell).toBe(true);
  });

  test("bun run tidak disentuh", () => {
    expect(planChainInvocation('bun run "C:/x/sl.ts"').command).toBe('bun run "C:/x/sl.ts"');
  });

  // .sh yang muncul di TENGAH perintah berarti pemanggilnya sudah memilih
  // interpreter sendiri -- jangan ditimpa.
  test("interpreter yang sudah ditulis sendiri tidak ditimpa", () => {
    expect(planChainInvocation('bash "C:/x/sl.sh"').command).toBe('bash "C:/x/sl.sh"');
    expect(planChainInvocation('sh "C:/x/sl.sh"').command).toBe('sh "C:/x/sl.sh"');
  });

  test("spasi di sekitar perintah dirapikan", () => {
    expect(planChainInvocation("   C:/x/sl.sh   ").command).toBe('bash "C:/x/sl.sh"');
  });
});
