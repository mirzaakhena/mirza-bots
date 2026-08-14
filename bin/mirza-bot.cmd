@echo off
rem ============================================================================
rem  mirza-bot — jalankan bot di folder ini lewat cc-wrapper (sistem BARU).
rem
rem    mirza-bot         jalan, cepat, tanpa menyentuh jaringan
rem    mirza-bot -u      update cc-plugin dulu, baru jalan
rem
rem  Selalu memakai folder tempat kamu berdiri. Tidak menerima nama bot atau
rem  path: tiap bot dijalankan dari foldernya sendiri, jadi argumen itu tidak
rem  pernah dipakai — dan parameter yang tidak dipakai tetap berbiaya, dalam
rem  bentuk percabangan yang harus dibaca dan dipahami orang berikutnya.
rem
rem  Update ada di belakang -u karena terukur mahal: ~6,5 detik, 5,6 detik di
rem  antaranya `marketplace update` yang menembak GitHub. Tanpa flag, ~0,3 detik.
rem
rem  Versi cc-plugin yang BENAR-BENAR terpasang tetap dicetak. Plugin dimuat
rem  dari CACHE dan bukan dari repo, jadi angka itu satu-satunya petunjuk murah
rem  bahwa kode yang berjalan sudah usang. Ketinggalan → ulangi dengan -u.
rem
rem  Terpasang di %USERPROFILE%\.local\bin\ · sumber di mirza-bots\bin\
rem ============================================================================
setlocal
set "WRAPPER=C:\Users\Mirza\workspace\mirza-bots\cc-wrapper"
set "INSTALLED=%USERPROFILE%\.claude\plugins\installed_plugins.json"
set "CLAUDE_PROJECT_DIR=%CD%"

if /i "%~1"=="-u" (
  echo [mirza-bot] mengambil rilis terbaru...
  call claude plugin marketplace update mirza-bots >nul 2>&1
  call claude plugin update cc-plugin@mirza-bots >nul 2>&1
)

rem  Satu panggilan powershell, DUA jawaban — versi plugin lalu PID shell yang
rem  memanggil kita. Digabung karena panggilan powershell-nya sendiri yang
rem  mahal (~0,3 detik); memisahnya menggandakan biaya start demi satu angka.
rem
rem  Angka kedua itu dipakai cc-wrapper sebagai "pemilik": kalau shell ini
rem  hilang, wrapper menutup sesi CC-nya. Tanpa itu, terminal yang mati
rem  meninggalkan claude.exe hidup selamanya — Windows tidak mengirim apa pun
rem  ke anak saat induknya mati (diukur, lihat cc-wrapper/src/shutdown.ts).
rem
rem  Naik rantai sambil MELEWATI cmd.exe, bukan naik sekian tingkat tetap.
rem  Jumlah tingkatnya tidak tetap: `for /f` menyisipkan satu cmd.exe sendiri,
rem  dan cmd.exe menjalankan .cmd di prosesnya sendiri kalau dipanggil dari
rem  Command Prompt tapi TIDAK kalau dipanggil dari PowerShell. Diukur di sini
rem  2026-08-13: powershell -> cmd(for) -> cmd(skrip ini) -> shell pemanggil.
rem  Yang dicari adalah leluhur pertama yang bukan cmd.exe, karena cmd.exe di
rem  rantai ini selalu perkakas, tidak pernah pemilik sesungguhnya.
set "VER="
set "OWNER="
rem  Kedua nilai SELALU dicetak, walau kosong: kalau baris pertama hilang,
rem  baris kedua naik jadi baris pertama dan PID pemilik terbaca sebagai versi.
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$v=((ConvertFrom-Json (Get-Content -Raw '%INSTALLED%')).plugins.'cc-plugin@mirza-bots')[0].version; if (-not $v) { $v='?' }; $o=0; try { $id=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).ParentProcessId; for ($i=0; $i -lt 8; $i++) { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id); if (-not $p) { break }; if ($p.Name -ne 'cmd.exe') { $o=$p.ProcessId; break }; $id=$p.ParentProcessId } } catch {}; if (-not $o) { $o=0 }; $v; $o"`) do (
  if not defined VER (set "VER=%%v") else if not defined OWNER (set "OWNER=%%v")
)

rem  Yang diset dari luar menang: launcher atau penjadwal lebih tahu siapa
rem  pemilik sesungguhnya daripada tebakan naik-dua-tingkat di atas.
if not defined CC_WRAPPER_OWNER_PID (
  if defined OWNER if not "%OWNER%"=="0" set "CC_WRAPPER_OWNER_PID=%OWNER%"
)

echo [mirza-bot] project   : %CLAUDE_PROJECT_DIR%
echo [mirza-bot] cc-plugin : %VER%
if defined CC_WRAPPER_OWNER_PID (
  echo [mirza-bot] pemilik   : PID %CC_WRAPPER_OWNER_PID% ^(sesi ditutup kalau shell ini hilang^)
) else (
  echo [mirza-bot] pemilik   : tidak diketahui - sesi TIDAK ikut tertutup otomatis
)

pushd "%WRAPPER%"
call npx tsx src/main.ts --dangerously-skip-permissions --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
popd
