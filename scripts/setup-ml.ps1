# Run from any directory: powershell -ExecutionPolicy Bypass -File scripts/setup-ml.ps1
# CPU is always installed. CUDA and DirectML are independent optional builds.
[CmdletBinding()]
param([switch]$CpuOnly, [switch]$WithCuda)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$mlDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'python_machine_learning'
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uvCommand) {
    throw 'Install uv first: winget install --id astral-sh.uv -e. Then reopen PowerShell and run this script.'
}
function Invoke-Uv {
    & $uvCommand.Source @args
    if ($LASTEXITCODE -ne 0) { throw "uv failed (exit $LASTEXITCODE): $args" }
}
function New-MlEnvironment([string]$Name, [string]$Version) {
    $environmentDirectory = Join-Path $mlDirectory $Name
    $interpreter = Join-Path $environmentDirectory 'Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $interpreter)) {
        Invoke-Uv python install $Version | Out-Host
        Invoke-Uv venv --python $Version $environmentDirectory | Out-Host
    }
    return $interpreter
}
$cpuPython = New-MlEnvironment '.venv-cpu' '3.14'
Invoke-Uv pip install --python $cpuPython -r (Join-Path $mlDirectory 'requirements-cpu.txt')
Invoke-Uv pip install --python $cpuPython -r (Join-Path $mlDirectory 'requirements-common.txt')
& $cpuPython (Join-Path $mlDirectory 'check_runtime.py') --backend cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU training self-test failed.' }
if (-not $CpuOnly) {
    try {
        $directmlPython = New-MlEnvironment '.venv-directml' '3.12'
        Invoke-Uv pip install --python $directmlPython -r (Join-Path $mlDirectory 'requirements-directml.txt')
        & $directmlPython (Join-Path $mlDirectory 'check_runtime.py') --backend directml
        if ($LASTEXITCODE -ne 0) { Write-Warning 'DirectML self-test failed. The launcher will use another GPU backend or CPU.' }
    } catch { Write-Warning "DirectML setup failed; CPU remains usable. $_" }
}
if ($WithCuda) {
    try {
        $cudaPython = New-MlEnvironment '.venv' '3.14'
        Invoke-Uv pip install --python $cudaPython -r (Join-Path $mlDirectory 'requirements-gpu.txt')
        Invoke-Uv pip install --python $cudaPython -r (Join-Path $mlDirectory 'requirements-common.txt')
        & $cudaPython (Join-Path $mlDirectory 'check_runtime.py') --backend cuda
        if ($LASTEXITCODE -ne 0) { Write-Warning 'CUDA self-test failed. The launcher will use DirectML or CPU.' }
    } catch { Write-Warning "CUDA setup failed; CPU remains usable. $_" }
}
Write-Host 'ML setup finished. Start RUN_PROGRAM.bat; the training service selects a working GPU, otherwise CPU.'
