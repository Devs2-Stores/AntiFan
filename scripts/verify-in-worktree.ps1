<#
.SYNOPSIS
  Verify a git ref in a throwaway worktree with the repo's node_modules linked in, and tear it
  down without ever touching the real node_modules.

.DESCRIPTION
  1. Adds a detached worktree of -Ref at -Path (outside the repo).
  2. Links the repo's node_modules into it with an NTFS junction, and copies the repo's gitignored
     packages\site-clone\dist (when present) into it as real files so tsc can resolve the
     tracked scripts\probes\sapo-boundary-probe.ts import.
  3. Runs only: tsc -p ./, scripts\copy-static.mjs, scripts\check-renderer-assets.mjs.
     It does NOT run npm run compile: that script also stages the terminal daemon host and
     rewrites the live daemon-host/current.json.
  4. Removes the worktree. The junction goes first, with `cmd /c rmdir` (removes the link only),
     is confirmed gone with `dir /AL`, and `git worktree remove` is refused while any junction is
     left. `git worktree remove --force` and recursive deletes follow a junction and empty the
     real node_modules, which is why this order is not optional.

  -Keep leaves the worktree for inspection (remove it later with -Cleanup).
  -Cleanup only removes an existing worktree at -Path, with the same junction-first order.
  -Repo selects another repository root (default: the parent of this script's folder).

  Failures in a bare worktree from files that only a full compile produces (the staged daemon
  host) are environment, not regressions in the ref. packages\site-clone\dist is copied from
  -Repo when it exists there; if it is absent in -Repo too, tsc fails on the probe import.
#>
param(
  [string]$Ref = 'HEAD',
  [string]$Path = 'E:\Work\scratch\wt-verify',
  [string]$Repo = '',
  [switch]$Keep,
  [switch]$Cleanup
)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = (Resolve-Path -LiteralPath $Repo).Path.TrimEnd('\')
$Path = [IO.Path]::GetFullPath($Path).TrimEnd('\')

if ($Path -eq $Repo -or $Path.StartsWith($Repo + '\', [StringComparison]::OrdinalIgnoreCase)) {
  Write-Output "WORKTREE_INSIDE_REPO: $Path must live outside $Repo"
  exit 1
}

function Get-JunctionLines([string]$Wt) {
  # `dir /AL` lists the reparse points of one folder as <JUNCTION> / <SYMLINKD> rows. It writes
  # "File Not Found" to stderr when there are none, which must not become a terminating error.
  $ErrorActionPreference = 'Continue'
  $rows = @(& cmd.exe /c dir /AL "$Wt" 2>$null)
  return @($rows | Where-Object { $_ -match '<(JUNCTION|SYMLINKD|SYMLINK)>' })
}

function Remove-NodeModulesJunction([string]$Wt) {
  $link = Join-Path $Wt 'node_modules'
  if (-not (Test-Path -LiteralPath $link)) { return }
  $item = Get-Item -LiteralPath $link -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  & cmd.exe /c rmdir "$link" | Out-Null
}

# Returns $true when the worktree is gone. Never reaches `git worktree remove` while a link remains.
# Diagnostics use Write-Host: a function's output stream is its return value.
function Remove-VerificationWorktree([string]$Wt) {
  if (-not (Test-Path -LiteralPath $Wt)) {
    & git -C $Repo worktree prune | Out-Null
    return $true
  }
  Remove-NodeModulesJunction $Wt
  $left = @(Get-JunctionLines $Wt)
  if ($left.Count -eq 0) {
    $nested = @(Get-ChildItem -LiteralPath $Wt -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notlike (Join-Path $Wt '.git\*') })
    $left = @($nested | ForEach-Object { $_.FullName })
  }
  if ($left.Count -gt 0) {
    Write-Host "JUNCTION_REMAINS: not removing $Wt; a recursive delete would follow it into a real folder"
    $left | ForEach-Object { Write-Host "  $_" }
    return $false
  }
  & git -C $Repo worktree remove --force "$Wt" | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "WORKTREE_REMOVE_FAILED: git exit $LASTEXITCODE"; return $false }
  return $true
}

if ($Cleanup) {
  if (Remove-VerificationWorktree $Path) { Write-Output "CLEANED: $Path"; exit 0 }
  exit 2
}

if (Test-Path -LiteralPath $Path) { Write-Output "WORKTREE_EXISTS: $Path (remove it with -Cleanup first)"; exit 1 }
$realModules = Join-Path $Repo 'node_modules'
if (-not (Test-Path -LiteralPath $realModules)) { Write-Output "NODE_MODULES_MISSING: $realModules"; exit 1 }

& git -C $Repo worktree add --detach "$Path" $Ref
if ($LASTEXITCODE -ne 0) { Write-Output "WORKTREE_ADD_FAILED: git exit $LASTEXITCODE"; exit 1 }

$failedStep = $null
$cleanupFailed = $false
try {
  New-Item -ItemType Junction -Path (Join-Path $Path 'node_modules') -Target $realModules | Out-Null
  # packages\site-clone\dist is gitignored build output that scripts\probes\sapo-boundary-probe.ts
  # imports; without it tsc exits 2 in a bare worktree. Copy real files (never a junction: the
  # cleanup refuses nested links).
  $realDist = Join-Path $Repo 'packages\site-clone\dist'
  $wtDist = Join-Path $Path 'packages\site-clone\dist'
  if ((Test-Path -LiteralPath $realDist) -and -not (Test-Path -LiteralPath $wtDist)) {
    Copy-Item -LiteralPath $realDist -Destination $wtDist -Recurse
  }
  Push-Location $Path
  try {
    $steps = @(
      @{ Name = 'tsc'; Args = @('node_modules\typescript\bin\tsc', '-p', './') },
      @{ Name = 'copy-static'; Args = @('scripts\copy-static.mjs') },
      @{ Name = 'check-renderer-assets'; Args = @('scripts\check-renderer-assets.mjs') }
    )
    foreach ($step in $steps) {
      Write-Output "== $($step.Name)"
      & node @($step.Args)
      if ($LASTEXITCODE -ne 0) { $failedStep = "$($step.Name) (exit $LASTEXITCODE)"; break }
    }
  } finally {
    Pop-Location
  }
} catch {
  $failedStep = "setup: $($_.Exception.Message)"
} finally {
  if ($Keep) {
    Write-Output "KEPT: $Path (remove with: scripts\verify-in-worktree.ps1 -Cleanup -Path `"$Path`")"
  } elseif (-not (Remove-VerificationWorktree $Path)) {
    Write-Output "CLEANUP_INCOMPLETE: $Path still exists"
    $cleanupFailed = $true
  }
}

if ($failedStep) { Write-Output "VERIFY_FAIL: $failedStep"; exit 1 }
if ($cleanupFailed) { exit 2 }
Write-Output "VERIFY_PASS: $Ref (tsc, copy-static, check-renderer-assets)"
exit 0
