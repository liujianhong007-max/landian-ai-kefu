$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin = Join-Path $Root 'bin'
$Src = Join-Path $Root 'WindowDiagnostics.cs'
$Out = Join-Path $Bin 'WindowDiagnostics.exe'
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Wpf = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
$UiaClient = Join-Path $Wpf 'UIAutomationClient.dll'
$UiaTypes = Join-Path $Wpf 'UIAutomationTypes.dll'
$WindowsBase = Join-Path $Wpf 'WindowsBase.dll'

if (!(Test-Path $Csc)) {
  throw "csc.exe not found: $Csc"
}

New-Item -ItemType Directory -Force -Path $Bin | Out-Null

& $Csc /nologo /target:exe /platform:x64 /optimize+ `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:$UiaClient `
  /reference:$UiaTypes `
  /reference:$WindowsBase `
  /out:$Out `
  $Src

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host $Out
