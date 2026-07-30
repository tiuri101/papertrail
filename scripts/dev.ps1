[CmdletBinding()]
param(
    [ValidateSet(
        "help",
        "setup",
        "db-up",
        "db-down",
        "db-reset",
        "db-status",
        "migrate",
        "create-admin",
        "api",
        "worker",
        "frontend",
        "start",
        "test",
        "test-e2e"
    )]
    [string]$Command = "help"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$EnvFile = Join-Path $Root ".env.development"
$EnvExample = Join-Path $Root ".env.development.example"
$ComposeFile = Join-Path $Root "docker-compose.dev.yml"
$VenvPython = Join-Path $Backend ".venv\Scripts\python.exe"

function Ensure-DevelopmentEnvironmentFile {
    if (-not (Test-Path $EnvFile)) {
        Copy-Item $EnvExample $EnvFile
        Write-Host "Created .env.development from .env.development.example."
    }
}

function Invoke-DevelopmentCompose {
    Ensure-DevelopmentEnvironmentFile
    & docker compose -f $ComposeFile --env-file $EnvFile @args
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed with exit code $LASTEXITCODE"
    }
}

function Get-BootstrapPython {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return @("py", "-3")
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return @("python")
    }
    throw "Python 3.12 or newer was not found. Install Python and reopen PowerShell."
}

function Ensure-VirtualEnvironment {
    if (Test-Path $VenvPython) {
        return
    }
    $launcher = Get-BootstrapPython
    Write-Host "Creating backend virtual environment..."
    if ($launcher.Count -eq 2) {
        & $launcher[0] $launcher[1] -m venv (Join-Path $Backend ".venv")
    }
    else {
        & $launcher[0] -m venv (Join-Path $Backend ".venv")
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the Python virtual environment."
    }
}

function Assert-VirtualEnvironment {
    if (-not (Test-Path $VenvPython)) {
        throw "Backend virtual environment not found. Run: .\scripts\dev.ps1 setup"
    }
}

function Invoke-BackendPython {
    Assert-VirtualEnvironment
    Push-Location $Backend
    try {
        & $VenvPython @args
        if ($LASTEXITCODE -ne 0) {
            throw "Backend command failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Show-Help {
    @"
Papertrail local-development helper

Usage:
  .\scripts\dev.ps1 setup          Install local dependencies and start PostgreSQL
  .\scripts\dev.ps1 create-admin   Create the local administrator interactively
  .\scripts\dev.ps1 start          Open API, worker, and frontend in separate windows

Individual processes:
  .\scripts\dev.ps1 api
  .\scripts\dev.ps1 worker
  .\scripts\dev.ps1 frontend

Database:
  .\scripts\dev.ps1 db-up
  .\scripts\dev.ps1 db-down
  .\scripts\dev.ps1 db-reset       Deletes the local development database
  .\scripts\dev.ps1 db-status
  .\scripts\dev.ps1 migrate

Tests:
  .\scripts\dev.ps1 test
  .\scripts\dev.ps1 test-e2e
"@ | Write-Host
}

switch ($Command) {
    "help" {
        Show-Help
    }
    "setup" {
        Ensure-DevelopmentEnvironmentFile
        Invoke-DevelopmentCompose up -d --wait postgres
        Ensure-VirtualEnvironment

        Write-Host "Installing backend dependencies..."
        Invoke-BackendPython -m pip install --upgrade pip
        Invoke-BackendPython -m pip install -e ".[dev]"
        Invoke-BackendPython -m alembic upgrade head

        Write-Host "Installing frontend dependencies..."
        Push-Location $Frontend
        try {
            npm install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }

        Write-Host ""
        Write-Host "Development setup is ready."
        Write-Host "Next: .\scripts\dev.ps1 create-admin"
        Write-Host "Then: .\scripts\dev.ps1 start"
    }
    "db-up" {
        Invoke-DevelopmentCompose up -d --wait postgres
    }
    "db-down" {
        Invoke-DevelopmentCompose down
    }
    "db-reset" {
        Write-Warning "This deletes the local Papertrail development database."
        $confirmation = Read-Host "Type RESET to continue"
        if ($confirmation -ne "RESET") {
            Write-Host "Database reset cancelled."
            break
        }
        Invoke-DevelopmentCompose down -v
        Invoke-DevelopmentCompose up -d --wait postgres
        Invoke-BackendPython -m alembic upgrade head
        Write-Host "Development database reset complete."
    }
    "db-status" {
        Invoke-DevelopmentCompose ps
    }
    "migrate" {
        Invoke-BackendPython -m alembic upgrade head
    }
    "create-admin" {
        Invoke-BackendPython -m app.cli create-admin
    }
    "api" {
        Invoke-BackendPython -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
    }
    "worker" {
        Invoke-BackendPython -m app.jobs.worker
    }
    "frontend" {
        Push-Location $Frontend
        try {
            npm run dev
            if ($LASTEXITCODE -ne 0) {
                throw "Frontend development server failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
    }
    "start" {
        Ensure-DevelopmentEnvironmentFile
        Invoke-DevelopmentCompose up -d --wait postgres
        Assert-VirtualEnvironment
        $PowerShellExecutable = (Get-Process -Id $PID).Path
        foreach ($Subcommand in @("api", "worker", "frontend")) {
            $ArgumentLine = "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Subcommand"
            Start-Process -FilePath $PowerShellExecutable -ArgumentList $ArgumentLine
        }
        Write-Host "Started API, worker, and frontend in separate PowerShell windows."
        Write-Host "Open http://localhost:5173"
    }
    "test" {
        Invoke-BackendPython -m pytest
        Invoke-BackendPython -m ruff check app tests
        Push-Location $Frontend
        try {
            npm run typecheck
            if ($LASTEXITCODE -ne 0) { throw "Frontend typecheck failed" }
            npm run lint
            if ($LASTEXITCODE -ne 0) { throw "Frontend lint failed" }
            npm test
            if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }
        }
        finally {
            Pop-Location
        }
    }
    "test-e2e" {
        Push-Location $Frontend
        try {
            npx playwright install chromium
            if ($LASTEXITCODE -ne 0) { throw "Playwright browser installation failed" }
            npm run test:e2e
            if ($LASTEXITCODE -ne 0) { throw "Playwright tests failed" }
        }
        finally {
            Pop-Location
        }
    }
}
