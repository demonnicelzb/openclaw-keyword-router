#Requires -Version 5.1
<#
.SYNOPSIS
    Install keyword-router straight from a GitHub repository.

.DESCRIPTION
    Downloads the repository archive from codeload.github.com, extracts it to a
    temporary folder and runs the bundled installer (install.ps1 -> install.mjs).

    ASCII only on purpose: Windows PowerShell 5.1 parses BOM-less UTF-8 scripts
    as ANSI, so non-ASCII text would break parsing before anything runs.

.PARAMETER Repo
    GitHub repository in "owner/name" form, for example "someone/keyword-router".

.PARAMETER Ref
    Branch or tag to download. Default: main

.PARAMETER Restart
    Restart the OpenClaw gateway after installing.

.EXAMPLE
    .\install-from-github.ps1 -Repo someone/keyword-router

.EXAMPLE
    # one-liner (download to disk first, then run; piping into iex is fragile)
    irm https://raw.githubusercontent.com/someone/keyword-router/main/install-from-github.ps1 -OutFile $env:TEMP\okr.ps1
    powershell -ExecutionPolicy Bypass -File $env:TEMP\okr.ps1 -Repo someone/keyword-router
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [string]$Ref = 'main',
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    chcp 65001 > $null
} catch {
    # console encoding only; ignore
}

$temp = Join-Path $env:TEMP ('okr-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $temp 'repo.zip'
$url = "https://codeload.github.com/$Repo/zip/refs/heads/$Ref"

Write-Host "Repository : $Repo"
Write-Host "Ref        : $Ref"
Write-Host "Download   : $url"

try {
    New-Item -ItemType Directory -Force -Path $temp | Out-Null

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch {
        # already sufficient on newer systems
    }

    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force

    $root = Get-ChildItem -LiteralPath $temp -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'install.mjs') } |
        Select-Object -First 1

    if (-not $root) {
        throw 'install.mjs was not found in the downloaded archive. Is this the right repository?'
    }

    Write-Host "Extracted  : $($root.FullName)"
    Write-Host ''

    $installer = Join-Path $root.FullName 'install.ps1'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer)
    if ($Restart) { $argv += '-Restart' }

    & powershell @argv
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    exit $code
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
