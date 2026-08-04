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
rem  Update cc-plugin dijalankan SELALU, bukan lewat flag. Plugin dimuat dari
rem  cache dan bukan dari repo, jadi "lupa update" = menjalankan kode lama
rem  tanpa sadar -- sudah dua kali menghabiskan waktu di proyek ini. Menyerahkan
rem  itu ke ingatan manusia adalah beban yang salah alamat.
rem
rem  Terpasang di: %USERPROFILE%\.local\bin\mirza-bot.cmd  (sudah di PATH)
rem  Sumbernya di repo: mirza-bots\bin\mirza-bot.cmd
rem ============================================================================
setlocal
set "WRAPPER=C:\Users\Mirza\workspace\mirza-bots\cc-wrapper"
set "WORKSPACE=C:\Users\Mirza\workspace"
set "INSTALLED=%USERPROFILE%\.claude\plugins\installed_plugins.json"

if "%~1"=="" (
  set "CLAUDE_PROJECT_DIR=%CD%"
) else if exist "%~1\" (
  set "CLAUDE_PROJECT_DIR=%~f1"
) else (
  set "CLAUDE_PROJECT_DIR=%WORKSPACE%\%~1"
)

call claude plugin marketplace update mirza-bots >nul 2>&1
call claude plugin update cc-plugin@mirza-bots >nul 2>&1

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "((ConvertFrom-Json (Get-Content -Raw '%INSTALLED%')).plugins.'cc-plugin@mirza-bots')[0].version"`) do set "VER=%%v"

echo [mirza-bot] project   : %CLAUDE_PROJECT_DIR%
echo [mirza-bot] cc-plugin : %VER%

pushd "%WRAPPER%"
call npx tsx src/main.ts --dangerously-skip-permissions --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
popd
