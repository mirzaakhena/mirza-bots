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

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "((ConvertFrom-Json (Get-Content -Raw '%INSTALLED%')).plugins.'cc-plugin@mirza-bots')[0].version"`) do set "VER=%%v"

echo [mirza-bot] project   : %CLAUDE_PROJECT_DIR%
echo [mirza-bot] cc-plugin : %VER%

pushd "%WRAPPER%"
call npx tsx src/main.ts --dangerously-skip-permissions --dangerously-load-development-channels "plugin:cc-plugin@mirza-bots"
popd
