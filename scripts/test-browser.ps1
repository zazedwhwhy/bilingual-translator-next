param(
  [int]$TestPort = 8787,
  [int]$CacheTestPort = 8788,
  [string]$OutputPrefix = 'C:/Users/wange/Documents/ChatGPT/rea/.tmp/bt-browser',
  [string[]]$Scripts = @('browser-interactions.mjs','browser-refinements.mjs','browser-cache.mjs','browser-page-speed.mjs','browser.mjs','browser-documents.mjs','browser-platform-layouts.mjs','browser-video.mjs','browser-capture.mjs')
)
$ErrorActionPreference = 'Stop'
if ($TestPort -lt 1024 -or $TestPort -gt 65535 -or $CacheTestPort -lt 1024 -or $CacheTestPort -gt 65535 -or $TestPort -eq $CacheTestPort) { throw 'Specify two distinct local test ports between 1024 and 65535.' }
if ($env:BT_CACHE_SOURCE -or $env:BT_SPEED_SOURCE) { throw 'This runner verifies current production source; remove baseline source overrides first.' }
$allowed = @('browser-interactions.mjs','browser-refinements.mjs','browser-cache.mjs','browser-page-speed.mjs','browser.mjs','browser-documents.mjs','browser-platform-layouts.mjs','browser-video.mjs','browser-capture.mjs','browser-interaction-targets.mjs')
foreach ($scriptName in $Scripts) { if ($scriptName -notin $allowed) { throw ('Unsupported browser test: ' + $scriptName) } }
$productRoot = Split-Path -Parent $PSScriptRoot
$scratchRoot = [System.IO.Path]::GetFullPath((Join-Path $productRoot '.tmp'))
$harnessRoot = [System.IO.Path]::GetFullPath((Join-Path $scratchRoot ('browser-ports-' + [guid]::NewGuid().ToString('N'))))
if ([System.IO.Path]::GetDirectoryName($harnessRoot) -ne $scratchRoot) { throw 'Unsafe browser harness path' }
New-Item -ItemType Directory -Force -Path $harnessRoot | Out-Null
foreach ($name in @('src','test','manifest.json','package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $productRoot $name) -Destination $harnessRoot -Recurse }
$verified = 0
$production = @(Get-Item -LiteralPath (Join-Path $productRoot 'manifest.json')) + @(Get-ChildItem -LiteralPath (Join-Path $productRoot 'src') -File -Recurse)
foreach ($file in $production) {
  $relative = [System.IO.Path]::GetRelativePath($productRoot, $file.FullName)
  if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $harnessRoot $relative) -Algorithm SHA256).Hash) { throw ('Production copy mismatch: ' + $relative) }
  $verified++
}
$remapped = 0
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $harnessRoot 'test') -File -Recurse) {
  if ($file.Extension -notin @('.mjs','.js','.html','.json','.css')) { continue }
  $text = [System.IO.File]::ReadAllText($file.FullName)
  $changed = $text.Replace('8787', [string]$TestPort).Replace('8788', [string]$CacheTestPort)
  if ($text -ne $changed) { [System.IO.File]::WriteAllText($file.FullName, $changed, [System.Text.UTF8Encoding]::new($false)); $remapped++ }
}
$logRoot = [System.IO.Path]::GetFullPath((Join-Path $productRoot '../../.tmp'))
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
[ordered]@{ testPort=$TestPort; cachePort=$CacheTestPort; productionFilesVerified=$verified; testFilesRemapped=$remapped; scripts=$Scripts } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logRoot 'browser-port-receipt.json') -Encoding utf8
$previousOutput = $env:BT_OUTPUT
$passed = $false
try {
  foreach ($scriptName in $Scripts) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($scriptName)
    $env:BT_OUTPUT = $OutputPrefix + '-' + $name
    $log = Join-Path $logRoot ('031-final-' + $name + '.log')
    & node (Join-Path $harnessRoot ('test/' + $scriptName)) *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 40; throw ($scriptName + ' failed; owned harness retained at ' + $harnessRoot) }
    Write-Output ($scriptName + ': PASS')
  }
  $passed = $true
} finally {
  if ($null -eq $previousOutput) { Remove-Item Env:BT_OUTPUT -ErrorAction SilentlyContinue } else { $env:BT_OUTPUT = $previousOutput }
  if ($passed) {
    $resolved = [System.IO.Path]::GetFullPath($harnessRoot)
    if ([System.IO.Path]::GetDirectoryName($resolved) -ne $scratchRoot -or -not [System.IO.Path]::GetFileName($resolved).StartsWith('browser-ports-')) { throw 'Unsafe browser harness cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
