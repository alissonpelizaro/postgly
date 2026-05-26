# Postgly installer for Windows.
#
# Usage:
#   irm https://postgly.app/install.ps1 | iex
#   irm https://raw.githubusercontent.com/alissonpelizaro/postgly/main/scripts/install.ps1 | iex
#
# Optional:
#   $env:POSTGLY_VERSION = "v0.1.0"   # pin a specific release (default: latest)
#
# Requires: PowerShell 5+ (built into Windows 10/11).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$Repo    = 'alissonpelizaro/postgly'
$Version = if ($env:POSTGLY_VERSION) { $env:POSTGLY_VERSION } else { 'latest' }

function Write-Step($msg)    { Write-Host $msg -ForegroundColor DarkGray }
function Write-Info($msg)    { Write-Host $msg -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host $msg -ForegroundColor Green }
function Die($msg)           { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# --- detect arch ----------------------------------------------------------

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($arch -ne 'X64') {
    Die "unsupported arch: $arch (only x64 published today)"
}
$asset = 'Postgly-windows-x64-setup.exe'

# --- resolve version ------------------------------------------------------

if ($Version -eq 'latest') {
    Write-Step 'Resolving latest release...'
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
        $Version = $release.tag_name
    } catch {
        Die "could not resolve latest release: $($_.Exception.Message)"
    }
}

$url = "https://github.com/$Repo/releases/download/$Version/$asset"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("postgly-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$dest = Join-Path $tmp $asset

Write-Info 'Postgly installer'
Write-Host "  Platform : windows (x64)"
Write-Host "  Version  : $Version"
Write-Host "  Asset    : $asset"
Write-Host ''

try {
    # --- download ---------------------------------------------------------

    Write-Step 'Downloading...'
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    } catch {
        Die "download failed — check release exists at $url"
    }

    # Remove Mark of the Web (Zone.Identifier ADS) so SmartScreen is less aggressive.
    Write-Step 'Removing Mark of the Web...'
    try { Unblock-File -Path $dest } catch { }

    # --- run installer ----------------------------------------------------

    Write-Step 'Launching installer...'
    $proc = Start-Process -FilePath $dest -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        Die "installer exited with code $($proc.ExitCode)"
    }
}
finally {
    Write-Step 'Cleaning up downloaded files...'
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Success "Postgly installed."
Write-Host ''
Write-Host 'Launch it from the Start menu.'
