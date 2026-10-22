#Requires -Version 5.1
<#
.SYNOPSIS
    ASCII-only launcher for install.mjs (keyword-router).

.DESCRIPTION
    All real work lives in install.mjs so that Chinese output is written as
    UTF-8 by Node and never parsed as ANSI by Windows PowerShell 5.1.
    This file therefore contains ASCII only on purpose: a UTF-8 (no BOM)
    script with non-ASCII text would be mis-decoded by powershell.exe.

.PARAMETER TargetDir
    Install directory. Default: %USERPROFILE%\.openclaw\keyword-router

.PARAMETER Restart
    Run "openclaw gateway restart" after installing.

.PARAMETER Remove
    Remove the plugin entry from openclaw.json (files are kept).

.PARAMETER SkipConfig
    Copy files only, do not touch openclaw.json.

.PARAMETER DryRun
    Print what would happen, change nothing.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Restart
    .\install.ps1 -Remove -Restart
    .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$TargetDir,
    [switch]$Restart,
    [switch]$Remove,
    [switch]$SkipConfig,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Let the console render the UTF-8 output that Node writes (Chinese messages,
# IP output, etc). This only affects console rendering, not the install logic.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    chcp 65001 > $null
} catch {
    # Keep going; worst case the console shows some garbled Chinese text.
}

function Find-NodeExe {
    $candidates = @()
    $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += 'D:\node\node.exe'
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw 'node.exe not found. keyword-router needs the same Node runtime that OpenClaw uses (for example D:\node\node.exe).'
}

$node = Find-NodeExe
$installer = Join-Path $PSScriptRoot 'install.mjs'
if (-not (Test-Path -LiteralPath $installer)) { throw "Missing installer script: $installer" }

$argv = @($installer)
if ($TargetDir) { $argv += @('--target-dir', $TargetDir) }
if ($Restart) { $argv += '--restart' }
if ($Remove) { $argv += '--remove' }
if ($SkipConfig) { $argv += '--skip-config' }
if ($DryRun) { $argv += '--dry-run' }

& $node @argv
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
exit $code
