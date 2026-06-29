$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin = Join-Path $Root 'bin'
$Src = Join-Path $Root 'src\Program.cs'
$Out = if ($env:PDD_FUKE_HELPER_BUILD_OUT) { $env:PDD_FUKE_HELPER_BUILD_OUT } else { Join-Path $Bin 'PddFukeHelper.exe' }
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (!(Test-Path $Csc)) {
  throw "csc.exe not found: $Csc"
}

New-Item -ItemType Directory -Force -Path $Bin | Out-Null

& $Csc /nologo /target:exe /platform:x64 /optimize+ `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Web.Extensions.dll `
  /out:$Out `
  $Src

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host $Out
