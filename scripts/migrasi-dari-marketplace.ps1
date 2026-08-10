<#
.SYNOPSIS
  Memindahkan satu bot harian dari sistem lama (mirza-marketplace/plugins/telegram)
  ke sistem ini. Token direuse; riwayat TIDAK dibawa.

.DESCRIPTION
  Empat langkah, urutannya bagian dari kontrak (lihat docs/2026-08-10-migrasi-bot-06-spec.md §4):

    1. baca token dari .claude/channels/telegram/.env      <- satu-satunya salinan
    2. PINDAHKAN .claude/channels/ + settings.json ke arsip
    3. tulis .claude/settings.json baru (8 plugin lama = false, TANPA statusLine)
    4. tulis config.json                                    <- ini yang mengubah folder jadi bot

  Langkah 3 SEBELUM 4 adalah pagarnya: kalau config.json lahir lebih dulu, ada
  jendela di mana folder ini sah bagi KEDUA sistem -- satu membaca token dari
  .env, satu dari config.json, dan keduanya berhak. Telegram lalu membagi pesan
  secara ACAK antara dua poller, tanpa galat apa pun.

  DRY-RUN ADALAH DEFAULT. Tambahkan -Apply untuk benar-benar mengerjakannya.
  Mengikuti cc-plugin/scripts/migrate-per-folder.ts, yang juga dry-run default.

.PARAMETER Bot
  Nama folder bot (mis. bot-05). Diselesaikan relatif ke -Workspace.

.PARAMETER Apply
  Tanpa ini, skrip hanya MELAPORKAN apa yang akan dikerjakan dan tidak menyentuh
  satu berkas pun.

.EXAMPLE
  # 1. Tutup sesi Claude Code bot itu LEBIH DULU (lihat gerbang di bawah)
  # 2. Lihat rencananya:
  .\scripts\migrasi-dari-marketplace.ps1 -Bot bot-05
  # 3. Kerjakan:
  .\scripts\migrasi-dari-marketplace.ps1 -Bot bot-05 -Apply
  # 4. Nyalakan:
  cd C:\Users\Mirza\workspace\bot-05 ; mirza-bot -u

.NOTES
  Tidak ada test otomatis untuk skrip ini, dan itu keputusan yang dinyatakan
  bukan kelalaian: pengamannya bukan test melainkan (a) dry-run sebagai default
  dan (b) GERBANG yang menolak jalan kalau ada satu saja berkas terkunci --
  sehingga kegagalan yang paling mahal (arsip setengah jadi) tidak bisa terjadi.
  Jalankan dry-run dulu, tiap kali.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Bot,
  [switch]$Apply,
  [string]$Workspace = 'C:\Users\Mirza\workspace'
)

$ErrorActionPreference = 'Stop'

$botHome = Join-Path $Workspace $Bot
$claude  = Join-Path $botHome '.claude'
$chan    = Join-Path $claude 'channels'
$envPath = Join-Path $chan 'telegram\.env'
$accPath = Join-Path $chan 'telegram\access.json'
$cfgPath = Join-Path $botHome 'config.json'
$setPath = Join-Path $claude 'settings.json'

function Tolak($alasan) {
  Write-Host "TOLAK: $alasan" -ForegroundColor Red
  Write-Host "Tidak ada satu berkas pun yang disentuh." -ForegroundColor Red
  exit 1
}

Write-Host "=== migrasi $Bot ===" -ForegroundColor Cyan
if (-not $Apply) { Write-Host "MODE: dry-run (tambahkan -Apply untuk mengerjakan)" -ForegroundColor Yellow }

# --- GERBANG -----------------------------------------------------------------
# Semua diperiksa SEBELUM apa pun bergerak. Gerbang yang memeriksa di tengah
# jalan bukan gerbang; ia cuma tempat berhenti yang lebih buruk.

if (-not (Test-Path $botHome -PathType Container)) { Tolak "folder $botHome tidak ada" }

# Sudah dimigrasi: menimpanya akan MENGHAPUS config.json yang mungkin sudah
# disunting tangan, dan mengarsipkan state sistem BARU sebagai kalau-kalau ia
# milik sistem lama.
if (Test-Path $cfgPath) { Tolak "$cfgPath sudah ada -- bot ini tampaknya sudah dimigrasi" }

if (-not (Test-Path $envPath)) { Tolak "token tidak ditemukan di $envPath" }

$line  = (Get-Content $envPath) | Where-Object { $_ -match '^TELEGRAM_BOT_TOKEN=' } | Select-Object -First 1
$token = ($line -replace '^TELEGRAM_BOT_TOKEN=', '').Trim()
if ($token -notmatch '^\d{8,}:[A-Za-z0-9_\-]{30,}$') { Tolak "bentuk token di $envPath tidak dikenali" }

# GERBANG UTAMA: berkas yang handle-nya dipegang proses lain TIDAK BISA dipindah
# di Windows. Terukur 2026-08-10: messages.db ketiga bot yang diuji terkunci
# karena sesi Claude Code-nya masih hidup. Tanpa gerbang ini, Move-Item berhenti
# di tengah dan meninggalkan arsip setengah jadi -- keadaan yang lebih buruk
# daripada tidak mulai sama sekali.
$terkunci = @()
if (Test-Path $chan) {
  foreach ($f in Get-ChildItem $chan -Recurse -Force -File -ErrorAction SilentlyContinue) {
    try { $fs = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'None'); $fs.Close() }
    catch { $terkunci += $f.FullName.Replace("$botHome\", '') }
  }
}
if ($terkunci.Count -gt 0) {
  Write-Host "Berkas yang masih dipegang proses lain:" -ForegroundColor Red
  $terkunci | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  Tolak "sesi Claude Code $Bot tampaknya masih hidup -- TUTUP dulu sesinya, lalu ulangi"
}

# allowFrom dibaca dari access.json bot INI, bukan diketik ulang: chat id yang
# salah membuat bot bisu total, dan bisu tidak punya gejala selain sunyi.
$allowFrom = @()
if (Test-Path $accPath) {
  $acc = Get-Content -Raw $accPath | ConvertFrom-Json
  if ($acc.allowFrom) { $allowFrom = @($acc.allowFrom) }
}
if ($allowFrom.Count -eq 0) { Tolak "allowFrom kosong / $accPath tidak terbaca -- bot tanpa allowFrom bisu total" }

# Peringatan, BUKAN gerbang: pembersihan scope menu Telegram lahir di 0.42.0.
# Versi di bawah itu tetap bisa dimigrasi -- menunya saja yang tidak berubah di
# HP, dan `mirza-bot -u` menyembuhkannya.
$installed = 'tidak terbaca'
try {
  $ip = Join-Path $env:USERPROFILE '.claude\plugins\installed_plugins.json'
  $installed = ((Get-Content -Raw $ip | ConvertFrom-Json).plugins.'cc-plugin@mirza-bots')[0].version
} catch { }

Write-Host "  token          : $($token.Split(':')[0]):<dirahasiakan>  (panjang $($token.Length))"
Write-Host "  allowFrom      : $($allowFrom -join ', ')"
Write-Host "  cc-plugin      : $installed"
if ($installed -ne 'tidak terbaca' -and [version]($installed -replace '[^0-9.]','') -lt [version]'0.42.0') {
  Write-Host "  PERINGATAN: <0.42.0 -- scope menu Telegram lama tidak akan dibersihkan. Jalankan 'mirza-bot -u'." -ForegroundColor Yellow
}

$ts    = (Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')
$arsip = Join-Path $botHome "_arsip-migrasi-$ts"
Write-Host "  arsip          : _arsip-migrasi-$ts"

if (-not $Apply) {
  Write-Host "`nYang AKAN dikerjakan:" -ForegroundColor Yellow
  Write-Host "  2. pindahkan .claude\channels\ + settings.json (+ backup-nya) -> arsip"
  Write-Host "  3. tulis .claude\settings.json baru (8 plugin lama = false, tanpa statusLine)"
  Write-Host "  4. tulis config.json"
  Write-Host "`nUlangi dengan -Apply untuk mengerjakannya." -ForegroundColor Yellow
  exit 0
}

# --- KERJAKAN ----------------------------------------------------------------
New-Item -ItemType Directory -Path $arsip | Out-Null
if (Test-Path $chan)    { Move-Item $chan    (Join-Path $arsip 'channels') }
if (Test-Path $setPath) { Move-Item $setPath (Join-Path $arsip 'settings.json') }
Get-ChildItem $claude -Filter 'settings.json.backup-*' -Force -ErrorAction SilentlyContinue |
  ForEach-Object { Move-Item $_.FullName $arsip }
Write-Host "  [2] state lama dipindah ke arsip" -ForegroundColor Green

# UTF8 TANPA BOM. Set-Content/Out-File menambahkan BOM di PowerShell 5.1 dan
# engine mati karenanya tiga kali (SCAR-026).
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Disalin apa adanya dari mirza_01_bot/.claude/settings.json -- konfigurasi
# rujukannya adalah folder itu, bukan dokumen mana pun.
$settings = @'
{
  "enabledPlugins": {
    "telegram@mirza-marketplace": false,
    "agent-bus@mirza-marketplace": false,
    "pty-controller@mirza-marketplace": false,
    "immediate-reply@mirza-marketplace": false,
    "inline-buttons@mirza-marketplace": false,
    "bot-conduct@mirza-marketplace": false,
    "teach-me@mirza-marketplace": false,
    "handoff@mirza-marketplace": false
  }
}
'@
New-Item -ItemType Directory -Path $claude -Force | Out-Null
[System.IO.File]::WriteAllText($setPath, $settings, $utf8)
Write-Host "  [3] .claude\settings.json ditulis" -ForegroundColor Green

$config = [ordered]@{ token = $token; allowFrom = $allowFrom; timezone = 'Asia/Jakarta' } | ConvertTo-Json
[System.IO.File]::WriteAllText($cfgPath, $config + "`n", $utf8)
Write-Host "  [4] config.json ditulis" -ForegroundColor Green

# --- PERIKSA ULANG -----------------------------------------------------------
# Menulis tanpa membaca ulang adalah niat, bukan jaminan (install.ts pagar 2).
$ulang = (Get-Content -Raw $cfgPath | ConvertFrom-Json).token
$arsipEnv = Join-Path $arsip 'channels\telegram\.env'
$asli = ((Get-Content $arsipEnv) -replace '^TELEGRAM_BOT_TOKEN=', '').Trim()
if (-not ($ulang -ceq $asli)) { Tolak "PERIKSA GAGAL: token di config.json tidak identik dengan yang di arsip" }
Get-Content -Raw $setPath | ConvertFrom-Json | Out-Null
Write-Host "  [ok] token identik byte-per-byte; settings.json valid JSON" -ForegroundColor Green

Write-Host "`nBerikutnya:" -ForegroundColor Cyan
Write-Host "  cd $botHome"
Write-Host "  mirza-bot -u"
Write-Host "  (lalu force-close + buka ulang Telegram di HP supaya menunya disegarkan)"
