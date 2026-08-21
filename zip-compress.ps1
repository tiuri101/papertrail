$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDirectory = [System.IO.Path]::GetFullPath(
    (Split-Path -Parent $MyInvocation.MyCommand.Path)
).TrimEnd('\', '/')

$folderName = Split-Path -Leaf $sourceDirectory
$zipPath = Join-Path $sourceDirectory "$folderName.zip"

# Build outside the project directory to prevent the ZIP from including itself.
$tempZipPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    "$folderName-$([Guid]::NewGuid().ToString('N')).zip"

$excludedRootDirectories = @(
    ".claude",
    ".git",
    ".idea"
)

# Relative (forward-slash) paths, from the repo root, to exclude regardless of depth.
$excludedRelativePaths = @(
    "backend/data",
    "frontend/data"
)

function Test-ExcludedDirectory {
    param(
        [System.IO.DirectoryInfo]$Directory,
        [int]$Depth
    )

    # Exclude node_modules everywhere.
    if ($Directory.Name.Equals(
        "node_modules",
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return $true
    }

    $relativePath = ($Directory.FullName.Substring($sourceDirectory.Length).TrimStart([char[]]"\/")) -replace '\\', '/'
    foreach ($excludedPath in $excludedRelativePaths) {
        if ($relativePath.Equals(
            $excludedPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return $true
        }
    }

    if ($Depth -eq 0) {
        # At root level, exclude only these named dot-directories.
        foreach ($excludedName in $excludedRootDirectories) {
            if ($Directory.Name.Equals(
                $excludedName,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                return $true
            }
        }
    }
    elseif ($Directory.Name.StartsWith(".")) {
        # Below the root, exclude all dot-prefixed directories.
        return $true
    }

    return $false
}

function Add-DirectoryContents {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [System.IO.DirectoryInfo]$Directory,
        [string]$ArchivePath,
        [int]$Depth
    )

    # Add files in the current directory.
    foreach ($file in $Directory.GetFiles()) {
        # Extra protection in case an old output ZIP exists.
        if ($file.FullName.Equals(
            $zipPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            continue
        }

        $entryName = if ([string]::IsNullOrEmpty($ArchivePath)) {
            $file.Name
        }
        else {
            "$ArchivePath/$($file.Name)"
        }

        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $Archive,
            $file.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }

	foreach ($childDirectory in $Directory.GetDirectories()) {
		if (Test-ExcludedDirectory `
			-Directory $childDirectory `
			-Depth $Depth
		) {
			$relativeSkippedPath = $childDirectory.FullName.Substring($sourceDirectory.Length).TrimStart([char[]]"\/")

			Write-Host "Skipping: $relativeSkippedPath"
			continue
		}

		$childArchivePath = if ([string]::IsNullOrEmpty($ArchivePath)) {
			$childDirectory.Name
		}
		else {
			"$ArchivePath/$($childDirectory.Name)"
		}

		$childArchivePath = $childArchivePath -replace '\\', '/'

		$Archive.CreateEntry("$childArchivePath/") | Out-Null

		Add-DirectoryContents `
			-Archive $Archive `
			-Directory $childDirectory `
			-ArchivePath $childArchivePath `
			-Depth ($Depth + 1)
	}
}

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

try {
    $zipStream = [System.IO.File]::Open(
        $tempZipPath,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )

    try {
        $archive = [System.IO.Compression.ZipArchive]::new(
            $zipStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )

        try {
            Add-DirectoryContents `
                -Archive $archive `
                -Directory ([System.IO.DirectoryInfo]::new($sourceDirectory)) `
                -ArchivePath "" `
                -Depth 0
        }
        finally {
            $archive.Dispose()
        }
    }
    finally {
        $zipStream.Dispose()
    }

    Move-Item `
        -LiteralPath $tempZipPath `
        -Destination $zipPath `
        -Force

    Write-Host ""
    Write-Host "Created archive: $zipPath"
}
finally {
    if (Test-Path -LiteralPath $tempZipPath) {
        Remove-Item -LiteralPath $tempZipPath -Force
    }
}