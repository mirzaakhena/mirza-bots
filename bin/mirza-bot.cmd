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
rem    mirza-bot -u bot-uji     update cc-plugin dulu, baru run
rem
rem  Terpasang di: %USERPROFILE%\.local\bin\mirza-bot.cmd  (sudah di PATH)
rem ============================================================================
setlocal
set "WRAPPER=C:\Users\Mirza\workspace\mirza-bots\cc-wrapper"
set "WORKSPACE=C:\Users\Mirza\workspace"
set "INSTALLED=%USERPROFILE%\.claude\plugins\installed_plugins.json"

set "TARGET=%~1"
if /i "%TARGET%"=="-u" (
  call claude plugin marketplace update mirza-bots
  call claude plugin update cc-plugin@mirza-bots
  set "TARGET=%~2"
)

if "%TARGET%"=="" (
  set "CLAUDE_PROJECT_DIR=%CD%"
) else if exist "%TARGET%\" (
  set "CLAUDE_PROJECT_DIR=%TARGET%"
) else (
  set "CLAUDE_PROJECT_DIR=%WORKSPACE%\%TARGET%"
)

rem Versi cc-plugin yang BENAR-BENAR terpasang. Dicetak saja, tidak memblokir:
rem plugin dimuat dari cache, jadi tanpa angka ini kamu bisa menjalankan kode
rem lama tanpa sadar -- sudah dua kali kejadian. Kalau angkanya ketinggalan,
rem jalankan ulang dengan -u.
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "((ConvertFrom-Json (Get-Content -Raw '%INSTALLED%')).plugins.'cc-plugin@mirza-bots')[0].version"`) do set "VER=%%v"

echo [mirza-bot] project   : %CLAUDE_PROJECT_DIR%
echo [mirza-bot] cc-plugin : %VER%

pushd "%WRAPPER%"
call npx tsx src/main.ts --dangerously-skip-permissions --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
popd
