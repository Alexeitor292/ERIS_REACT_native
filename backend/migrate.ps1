<#
.SYNOPSIS
Alembic helper for ERIS backend (Windows / PowerShell).

.DESCRIPTION
Wraps the alembic CLI, ensuring commands always run from the backend/
directory where alembic.ini and backend/.env are located.
DB credentials are read from backend/.env via app settings — never
from alembic.ini and never hardcoded here.

.EXAMPLE
.\migrate.ps1 current
.\migrate.ps1 history --verbose
.\migrate.ps1 heads
.\migrate.ps1 upgrade --sql head        # preview SQL without executing
.\migrate.ps1 stamp 0001_baseline       # stamp existing DB to baseline (once)
.\migrate.ps1 upgrade head              # apply pending migrations
.\migrate.ps1 revision -m "add_col_x"  # create a new migration file

.NOTES
Always take a mysqldump backup before running 'upgrade' on a real database.
See docs/MIGRATIONS.md for full procedures.
#>

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AlembicArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ScriptDir
try {
    alembic @AlembicArgs
}
finally {
    Pop-Location
}
