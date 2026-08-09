[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DefaultBranch = "main"

Push-Location $Root
try {
    if ((git status --porcelain) -ne $null) {
        Write-Error "Working tree has uncommitted changes. Commit or stash them before releasing."
    }

    $CurrentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($CurrentBranch -ne $DefaultBranch) {
        $confirmation = Read-Host "You are on branch `"$CurrentBranch`", not `"$DefaultBranch`". Continue anyway? [y/N]"
        if ($confirmation -notmatch '^[yY]$') {
            Write-Host "Cancelled."
            exit 0
        }
    }

    Write-Host "Fetching tags from origin..."
    git fetch origin --tags --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch failed with exit code $LASTEXITCODE"
    }

    if (-not $Version) {
        $YearMonth = Get-Date -Format "yyyy.MM"
        $ExistingPatches = git tag -l "$YearMonth.*" |
            ForEach-Object { $_.Substring($YearMonth.Length + 1) } |
            Where-Object { $_ -match '^\d+$' } |
            ForEach-Object { [int]$_ }
        $NextPatch = 1
        if ($ExistingPatches) {
            $NextPatch = ($ExistingPatches | Measure-Object -Maximum).Maximum + 1
        }
        $Version = "{0}.{1:D2}" -f $YearMonth, $NextPatch
    }

    git rev-parse $Version *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Error "Tag $Version already exists."
    }

    $confirmation = Read-Host "Release version $Version. Create and push this tag? [y/N]"
    if ($confirmation -notmatch '^[yY]$') {
        Write-Host "Cancelled."
        exit 0
    }

    git tag -a $Version -m "Release $Version"
    if ($LASTEXITCODE -ne 0) {
        throw "git tag failed with exit code $LASTEXITCODE"
    }

    git push origin $Version
    if ($LASTEXITCODE -ne 0) {
        throw "git push failed with exit code $LASTEXITCODE"
    }

    Write-Host "Pushed tag $Version."
    Write-Host "CI will build and push the $Version container images and create the GitHub release."
}
finally {
    Pop-Location
}
