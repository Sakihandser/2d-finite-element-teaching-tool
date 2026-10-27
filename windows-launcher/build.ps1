param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..'))
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework C# compiler was not found.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('fem-launcher-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    # Use the checked-in multi-resolution icon; never regenerate a 64px bitmap.
    $sourceIcon = Join-Path $PSScriptRoot '../assets/app.ico'
    if (-not (Test-Path -LiteralPath $sourceIcon)) { throw 'TENSORA icon asset is missing.' }
    $iconPath = Join-Path $scratch 'Tensora.ico'
    Copy-Item -LiteralPath $sourceIcon -Destination $iconPath
    $exe = Join-Path $scratch 'TENSORA.exe'
    & $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$exe" (Join-Path $PSScriptRoot 'Program.cs') (Join-Path $PSScriptRoot 'NativeProcess.cs') (Join-Path $PSScriptRoot 'WindowIcons.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
    $testExe = Join-Path $scratch 'LauncherTests.exe'
    & $compiler /nologo /codepage:65001 /target:exe /platform:x64 "/reference:$exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$testExe" (Join-Path $PSScriptRoot 'LauncherTests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher test compilation failed.' }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw 'Launcher validation failed.' }
    $destination = Join-Path $output 'TENSORA.exe'
    Copy-Item -LiteralPath $exe -Destination $destination -Force
    $assetDirectory = Join-Path $output 'assets'
    New-Item -ItemType Directory -Path $assetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $iconPath -Destination (Join-Path $assetDirectory 'app.ico') -Force
    Write-Output "Built: $destination"
} finally {
    $verifiedScratch = [IO.Path]::GetFullPath($scratch)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($verifiedScratch.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $verifiedScratch).StartsWith('fem-launcher-build-')) {
        Remove-Item -LiteralPath $verifiedScratch -Recurse -Force
    }
}
