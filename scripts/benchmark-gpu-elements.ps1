param([string]$Output = (Join-Path ([System.IO.Path]::GetTempPath()) 'fem-gpu-elements.csv'))
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$taskVs = & $taskVswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVs) { throw 'Visual Studio C++ x64 tools unavailable' }
$taskBuild = Join-Path $taskRoot '计算力学程序计算核心/x64/Debug/gpu-benchmark'
New-Item -ItemType Directory -Path $taskBuild -Force | Out-Null
$taskExe = Join-Path $taskBuild 'gpu-elements.exe'
$taskCore = Join-Path $taskRoot '计算力学程序计算核心'
$taskSetup = Join-Path $taskVs 'VC/Auxiliary/Build/vcvars64.bat'
# Only compiler setup/build uses cmd; file operations remain native PowerShell.
$taskCompile = 'call "{0}" >nul && cl /nologo /O2 /EHsc /std:c++17 /openmp /MT /utf-8 /I"{1}" /I"{1}/vendor/opencl" "{2}" "{1}/GpuElementBackend.cpp" "{1}/KeCalculation.cpp" "{1}/StressStrainCalculation.cpp" /Fe:"{3}"' -f $taskSetup, $taskCore, (Join-Path $PSScriptRoot 'benchmark-gpu-elements.cpp'), $taskExe
Push-Location $taskBuild
try { & cmd.exe /d /c $taskCompile; if ($LASTEXITCODE -ne 0) { throw 'GPU diagnostic compilation failed' } }
finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $taskCore 'x64/Release/vcomp140.dll') -Destination $taskBuild -Force
$taskCsv = & $taskExe
if ($LASTEXITCODE -ne 0) { throw 'GPU diagnostic or parity check failed' }
$taskTarget = if ([IO.Path]::IsPathRooted($Output)) { [IO.Path]::GetFullPath($Output) } else { [IO.Path]::GetFullPath((Join-Path $taskRoot $Output)) }
New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
[IO.File]::WriteAllText($taskTarget, ($taskCsv -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
$taskCsv
