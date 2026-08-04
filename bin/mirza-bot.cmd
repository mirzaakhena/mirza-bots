@echo off
rem ============================================================================
rem  mirza-bot — launcher global untuk cc-wrapper (sistem BARU, repo mirza-bots).
rem
rem  Sejajar dengan mirza-cc, yang melayani sistem LAMA. Sengaja berkas
rem  terpisah: mirza-cc dipakai enam bot harian, dan menumpanginya berarti
rem  mempertaruhkan yang produksi demi yang percobaan.
rem
rem  Pemakaian:
rem    mirza-bot                run untuk folder tempat kamu berdiri
rem    mirza-bot bot-uji        run untuk C:\Users\Mirza\workspace\bot-uji
rem    mirza-bot D:\some\path   run untuk path itu
rem
rem  UPDATE HANYA KALAU PERLU. Plugin dimuat dari cache dan bukan dari repo,
rem  jadi "lupa update" = menjalankan kode lama tanpa sadar. Tapi menjalankan
rem  update tiap start memakan ~6,5 detik, dan 5,6 detik di antaranya adalah
rem  `marketplace update` yang menembak GitHub. Terukur 2026-08-04.
rem
rem  Jalan tengahnya: bandingkan dulu versi di repo dengan versi yang terpasang
rem  -- keduanya berkas lokal, ~0,3 detik. Sama berarti tidak ada yang perlu
rem  diambil, dan update dilewati sepenuhnya. Jadi harga itu hanya dibayar pada
rem  start pertama sesudah rilis baru, bukan setiap kali.
rem
rem  Terpasang di: %USERPROFILE%\.local\bin\mirza-bot.cmd  (sudah di PATH)
rem  Sumbernya di repo: mirza-bots\bin\mirza-bot.cmd
rem ============================================================================
setlocal
set "REPO=C:\Users\Mirza\workspace\mirza-bots"
set "WRAPPER=%REPO%\cc-wrapper"
set "WORKSPACE=C:\Users\Mirza\workspace"
set "INSTALLED=%USERPROFILE%\.claude\plugins\installed_plugins.json"

if "%~1"=="" (
  set "CLAUDE_PROJECT_DIR=%CD%"
) else if exist "%~1\" (
  set "CLAUDE_PROJECT_DIR=%~f1"
) else (
  set "CLAUDE_PROJECT_DIR=%WORKSPACE%\%~1"
)

rem Dua pembacaan terpisah. Menggabungkannya jadi satu panggilan PowerShell
rem memang menghemat ~0,3 detik, tapi menuntut escaping kutip di dalam for/f
rem yang terbukti tidak bisa diandalkan -- percobaan pertama mengembalikan
rem kedua versi tergabung jadi satu token. Hemat yang tidak sepadan.
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(ConvertFrom-Json (Get-Content -Raw '%REPO%\cc-plugin\.claude-plugin\plugin.json')).version"`) do set "REPO_VER=%%v"
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "((ConvertFrom-Json (Get-Content -Raw '%INSTALLED%')).plugins.'cc-plugin@mirza-bots')[0].version"`) do set "VER=%%v"

if not "%REPO_VER%"=="%VER%" (
  echo [mirza-bot] cc-plugin %VER% -^> %REPO_VER%, mengambil rilis baru...
  call claude plugin marketplace update mirza-bots >nul 2>&1
  call claude plugin update cc-plugin@mirza-bots >nul 2>&1
  set "VER=%REPO_VER%"
)

echo [mirza-bot] project   : %CLAUDE_PROJECT_DIR%
echo [mirza-bot] cc-plugin : %VER%

pushd "%WRAPPER%"
call npx tsx src/main.ts --dangerously-skip-permissions --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
popd
