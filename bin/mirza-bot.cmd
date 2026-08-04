@echo off
rem ============================================================================
rem  mirza-bot — launcher global untuk cc-wrapper (sistem BARU, repo mirza-bots).
rem
rem  Sejajar dengan mirza-cc, yang melayani sistem LAMA. Sengaja berkas
rem  terpisah: mirza-cc dipakai enam bot harian, dan menumpanginya berarti
rem  mempertaruhkan yang produksi demi yang percobaan.
rem
rem  Pemakaian:
rem    mirza-bot         jalan, cepat, tanpa menyentuh jaringan
rem    mirza-bot -u      update cc-plugin dulu, baru jalan
rem
rem  Update ADA DI BELAKANG FLAG, keputusan user 2026-08-04. Terukur: update
rem  memakan ~6,5 detik, 5,6 detik di antaranya `marketplace update` yang
rem  menembak GitHub — terlalu mahal untuk dibayar di setiap start demi rilis
rem  yang jarang.
rem
rem  Versi yang benar-benar terpasang tetap dicetak (satu pembacaan berkas
rem  lokal, ~0,3 detik). Plugin dimuat dari CACHE dan bukan dari repo, jadi
rem  angka itu satu-satunya petunjuk cepat bahwa kode yang jalan sudah usang —
rem  dua kali di proyek ini waktu terbuang menguji perbaikan yang ternyata
rem  tidak pernah berjalan. Angkanya ketinggalan → ulangi dengan -u.
rem
rem  Terpasang di: %USERPROFILE%\.local\bin\mirza-bot.cmd  (sudah di PATH)
rem  Sumbernya di repo: mirza-bots\bin\mirza-bot.cmd
rem ============================================================================
setlocal
set "REPO=C:\Users\Mirza\workspace\mirza-bots"
set "WRAPPER=%REPO%\cc-wrapper"
set "WORKSPACE=C:\Users\Mirza\workspace"
set "INSTALLED=%USERPROFILE%\.claude\plugins\installed_plugins.json"

set "TARGET=%~1"
if /i "%TARGET%"=="-u" (
  echo [mirza-bot] mengambil rilis terbaru...
  call claude plugin marketplace update mirza-bots >nul 2>&1
  call claude plugin update cc-plugin@mirza-bots >nul 2>&1
  set "TARGET=%~2"
)

if "%TARGET%"=="" (
  set "CLAUDE_PROJECT_DIR=%CD%"
) else if exist "%TARGET%\" (
  set "CLAUDE_PROJECT_DIR=%TARGET%"
) else (
  set "CLAUDE_PROJECT_DIR=%WORKSPACE%\%TARGET%"
)

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "((ConvertFrom-Json (Get-Content -Raw '%INSTALLED%')).plugins.'cc-plugin@mirza-bots')[0].version"`) do set "VER=%%v"

echo [mirza-bot] project   : %CLAUDE_PROJECT_DIR%
echo [mirza-bot] cc-plugin : %VER%

pushd "%WRAPPER%"
call npx tsx src/main.ts --dangerously-skip-permissions --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
popd
