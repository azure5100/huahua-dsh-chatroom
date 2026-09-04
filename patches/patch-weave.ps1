# dsh-weave rc.14 patch script (idempotent, ASCII only)
#   Fix1: #dispatch line ~289 dshBridge access -> wrapped in try/catch
#   Fix2: Endpoint bind fixed UDP port (default 64605, override via DSH_WEAVE_PORT)
#   Fix3: ack readToEnd(4096) -> MAX_FRAME_BYTES (history >4KB TooLong / HTTP 500)
#   Fix4: MAX_FRAME_BYTES target = 4MB
# Usage:
#   powershell -ExecutionPolicy Bypass -File patch-weave.ps1 [-WeaveIndex "path"]
param(
    [string]$WeaveIndex = ""
)

$ErrorActionPreference = "Stop"
$DefaultPort = 64605

if (-not $WeaveIndex) {
    $WeaveIndex = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\dsh-weave\lib\index.js"
}
if (-not (Test-Path $WeaveIndex)) {
    Write-Host "[FAIL] file not found: $WeaveIndex" -ForegroundColor Red
    exit 1
}

$raw = [System.IO.File]::ReadAllText($WeaveIndex, [System.Text.Encoding]::UTF8)
$orig = $raw
$changed = $false

# ---------- Fix1: dshBridge try/catch ----------
$fix1Old = '      const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");'
$fix1New = "      let bridge;`n      try { bridge = this.ctx?.dshBridge ?? this.ctx?.get?.('dshBridge'); } catch { bridge = undefined; }"
if ($raw.Contains('try { bridge = this.ctx?.dshBridge')) {
    Write-Host "[Fix1] already patched, skip" -ForegroundColor Yellow
} elseif ($raw.Contains($fix1Old)) {
    $raw = $raw.Replace($fix1Old, $fix1New)
    Write-Host "[Fix1] applied dshBridge try/catch" -ForegroundColor Green
    $changed = $true
} else {
    Write-Host "[Fix1] WARN: target code not found, check version manually" -ForegroundColor Red
}

# ---------- Fix2: fixed UDP port ----------
$fix2Anchor = '    builder.secretKey(await this.#secretKey());'
$jsPortLine = '    const weavePort = Number(process.env.DSH_WEAVE_PORT ?? ' + $DefaultPort + ');'
$jsBindLine = '    if (Number.isInteger(weavePort) && weavePort > 0 && weavePort < 65536) builder.bindAddr("0.0.0.0:" + weavePort);'
$fix2Insert = $fix2Anchor + "`n" + $jsPortLine + "`n" + $jsBindLine
if ($raw.Contains('weavePort')) {
    Write-Host "[Fix2] already patched, skip" -ForegroundColor Yellow
} elseif ($raw.Contains($fix2Anchor)) {
    $raw = $raw.Replace($fix2Anchor, $fix2Insert)
    Write-Host "[Fix2] applied fixed-port patch (default $DefaultPort, override DSH_WEAVE_PORT)" -ForegroundColor Green
    $changed = $true
} else {
    Write-Host "[Fix2] WARN: target code not found, check version manually" -ForegroundColor Red
}

# ---------- Fix3+Fix4: frame size limits ----------
$fixFrameTarget = 'const MAX_FRAME_BYTES = 4 * 1024 * 1024;'
$fixFrameOlds = @('const MAX_FRAME_BYTES = 64 * 1024;', 'const MAX_FRAME_BYTES = 1024 * 1024;')
$fix3bOld = '        stream.recv.readToEnd(4096),'
$fix3bNew = '        stream.recv.readToEnd(MAX_FRAME_BYTES),'
$framePatched = $raw.Contains($fixFrameTarget)
if (-not $framePatched) {
    foreach ($old in $fixFrameOlds) {
        if ($raw.Contains($old)) { $raw = $raw.Replace($old, $fixFrameTarget); Write-Host "[Fix3/4a] MAX_FRAME_BYTES -> 4MB applied ($old)" -ForegroundColor Green; $changed = $true; $framePatched = $true; break }
    }
    if (-not $framePatched) { Write-Host "[Fix3/4a] WARN: MAX_FRAME_BYTES const not found (64K/1M)" -ForegroundColor Red }
} else { Write-Host "[Fix3/4a] frame already 4MB, skip" -ForegroundColor Yellow }
if ($raw.Contains($fix3bNew)) {
    Write-Host "[Fix3b] ack readToEnd already patched, skip" -ForegroundColor Yellow
} elseif ($raw.Contains($fix3bOld)) {
    $raw = $raw.Replace($fix3bOld, $fix3bNew); Write-Host "[Fix3b] ack readToEnd(4096)->MAX_FRAME_BYTES applied" -ForegroundColor Green; $changed = $true
} else { Write-Host "[Fix3b] WARN: readToEnd(4096) not found" -ForegroundColor Red }

if ($changed) {
    $bak = "$WeaveIndex.bak-portfix"
    if (-not (Test-Path $bak)) {
        [System.IO.File]::WriteAllText($bak, $orig, (New-Object System.Text.UTF8Encoding $true))
        Write-Host "[BACKUP] original saved to $bak" -ForegroundColor Cyan
    }
    [System.IO.File]::WriteAllText($WeaveIndex, $raw, (New-Object System.Text.UTF8Encoding $true))
    Write-Host "[OK] patch written: $WeaveIndex" -ForegroundColor Green
} else {
    Write-Host "[OK] nothing to do (all patches active)" -ForegroundColor Green
}

node --check $WeaveIndex 2>$null
if ($LASTEXITCODE -eq 0) { Write-Host "[SYNTAX] OK" -ForegroundColor Green }
else { Write-Host "[SYNTAX] FAILED! check file" -ForegroundColor Red }
