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
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object Drawing.Bitmap 64,64
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.Color]::FromArgb(20,36,63))
    $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(88,199,235)),3
    $points = [Drawing.PointF[]]@([Drawing.PointF]::new(12,50),[Drawing.PointF]::new(32,12),[Drawing.PointF]::new(52,50))
    $graphics.DrawPolygon($pen,$points)
    $graphics.DrawLine($pen,12,50,42,31)
    $graphics.DrawLine($pen,22,31,52,50)
    $graphics.DrawLine($pen,22,31,42,31)
    foreach ($point in $points) { $graphics.FillEllipse([Drawing.Brushes]::White,$point.X-3,$point.Y-3,6,6) }
    $iconHandle = $bitmap.GetHicon()
    $icon = [Drawing.Icon]::FromHandle($iconHandle)
    $iconPath = Join-Path $scratch 'FemDesktop.ico'
    $stream = [IO.File]::Create($iconPath)
    try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $graphics.Dispose(); $pen.Dispose(); $bitmap.Dispose() }
    $exe = Join-Path $scratch '计算力学程序.exe'
    & $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$exe" (Join-Path $PSScriptRoot 'Program.cs') (Join-Path $PSScriptRoot 'NativeProcess.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
    $testExe = Join-Path $scratch 'LauncherTests.exe'
    & $compiler /nologo /codepage:65001 /target:exe /platform:x64 "/reference:$exe" "/out:$testExe" (Join-Path $PSScriptRoot 'LauncherTests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher test compilation failed.' }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw 'Launcher validation failed.' }
    $destination = Join-Path $output '计算力学程序.exe'
    Copy-Item -LiteralPath $exe -Destination $destination -Force
    Write-Output "Built: $destination"
} finally {
    $verifiedScratch = [IO.Path]::GetFullPath($scratch)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($verifiedScratch.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $verifiedScratch).StartsWith('fem-launcher-build-')) {
        Remove-Item -LiteralPath $verifiedScratch -Recurse -Force
    }
}
