$ErrorActionPreference = 'Stop'
$productRoot = Split-Path -Parent $PSScriptRoot
$distributionPath = Join-Path $productRoot 'dist'
New-Item -ItemType Directory -Force -Path $distributionPath | Out-Null
$packageVersion = (Get-Content -LiteralPath (Join-Path $productRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$archivePath = Join-Path $distributionPath ('bilingual-translator-next-' + $packageVersion + '.zip')
Compress-Archive -LiteralPath @((Join-Path $productRoot 'manifest.json'), (Join-Path $productRoot 'src'), (Join-Path $productRoot 'LICENSE')) -DestinationPath $archivePath -Force
$digest = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
Set-Content -LiteralPath (Join-Path $distributionPath ('SHA256-' + $packageVersion + '.txt')) -Value ($digest.Hash + '  ' + (Split-Path -Leaf $archivePath)) -Encoding utf8
Write-Output $archivePath
Write-Output $digest.Hash
