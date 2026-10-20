$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$referenceDirectory = Join-Path $projectRoot 'python_machine_learning/reference/fea-diffusion'
$upstreamCommit = 'a19d0980268edfc1d3893acc55f211479e7cfd07'
$sourceFiles = @('README.md', 'environment.yml', 'generate_data.py', 'datagen/__init__.py',
  'datagen/custom_plotter.py', 'datagen/fea_analysis.py', 'datagen/generate.py',
  'datagen/mesh_generator.py', 'datagen/utils.py')
$records = @()
foreach ($sourceFile in $sourceFiles) {
  $destination = Join-Path $referenceDirectory $sourceFile
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  $sourceUrl = "https://raw.githubusercontent.com/namanxkumar/fea-diffusion/$upstreamCommit/$sourceFile"
  Invoke-WebRequest -Uri $sourceUrl -OutFile $destination
  $records += @{path=$sourceFile; sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()}
}
@{repository='https://github.com/namanxkumar/fea-diffusion'; commit=$upstreamCommit;
  license=$null; purpose='Local reading reference only; excluded from runtime and redistribution'; files=$records} |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $referenceDirectory 'source-manifest.json') -Encoding utf8
Write-Output "Downloaded $($sourceFiles.Count) reference files to $referenceDirectory"
Write-Output 'No upstream license was declared at this commit. These files are reading references, not runtime dependencies.'
