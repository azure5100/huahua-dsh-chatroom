# 0.2.0 adaptation applier (idempotent; ASCII-only on purpose so the script text
# never depends on the console/script encoding - all localized text lives in
# patches/adapt/<package>.json, read as UTF-8).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File patch-adapt.ps1 -Package <weave|chat|bridge> -Root <packageDir> [-DryRun]
#
# Semantics: already-applied edits are skipped; a drifted anchor only WARNs
# (never silently rewrites); every changed file is backed up once as .bak-adapt;
# changed .js files are parse-gated with node --check.
param(
    [Parameter(Mandatory = $true)][ValidateSet('weave', 'chat', 'bridge')][string]$Package,
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$specPath = Join-Path $here ('adapt\' + $Package + '.json')
if (-not (Test-Path $specPath)) { Write-Host ('[FAIL] spec not found: ' + $specPath); exit 1 }
if (-not (Test-Path $Root)) { Write-Host ('[FAIL] package root not found: ' + $Root); exit 1 }

$spec = [System.IO.File]::ReadAllText($specPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Write-Host ('[spec] ' + $spec.package + '  ' + $spec.adaptedFrom + ' -> ' + $spec.target)

$utf8 = New-Object System.Text.UTF8Encoding $false
$changed = 0; $skipped = 0; $applied = 0; $warn = 0
$touchedJs = @()

foreach ($f in $spec.files) {
    $target = Join-Path $Root $f.path
    if ($f.action -eq 'create') {
        if (Test-Path $target) { Write-Host ('[skip] ' + $f.path + ' already exists'); $skipped++ }
        else {
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            if (-not $DryRun) { [System.IO.File]::WriteAllText($target, $f.content, $utf8) }
            Write-Host ('[new ] ' + $f.path)
            $changed++; $applied++
        }
        continue
    }
    if (-not (Test-Path $target)) { Write-Host ('[FAIL] missing target: ' + $f.path); exit 1 }
    $text = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
    $orig = $text
    foreach ($e in $f.edits) {
        if ($e.marker -and $text.Contains($e.marker)) { Write-Host ('[skip] already applied: ' + $f.path); $skipped++; continue }
        if ((-not $e.marker) -and $e.absent -and (-not $text.Contains($e.absent))) { Write-Host ('[skip] removal already applied: ' + $f.path); $skipped++; continue }
        if ($text.Contains($e.old)) { $text = $text.Replace($e.old, $e.new); $applied++ }
        else { Write-Host ('[WARN] anchor drifted, needs manual check: ' + $f.path); $warn++ }
    }
    if ($text -ne $orig) {
        if (-not $DryRun) {
            $bak = $target + '.bak-adapt'
            if (-not (Test-Path $bak)) { [System.IO.File]::WriteAllText($bak, $orig, $utf8) }
            [System.IO.File]::WriteAllText($target, $text, $utf8)
        }
        Write-Host ('[ok  ] ' + $f.path)
        $changed++
        if ($f.path.EndsWith('.js')) { $touchedJs += $target }
    }
}

if (-not $DryRun) {
    foreach ($js in $touchedJs) {
        node --check $js 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host ('[syntax] OK ' + (Split-Path -Leaf $js)) }
        else { Write-Host ('[syntax] FAILED ' + $js); exit 2 }
    }
}
Write-Host ('[done] files changed=' + $changed + ' edits applied=' + $applied + ' skipped=' + $skipped + ' warnings=' + $warn)
if ($warn -gt 0) { exit 3 }
exit 0
