#!/usr/bin/env bash
# migrate.sh — Alembic helper for ERIS backend (Linux / macOS / Proxmox).
#
# Wraps the alembic CLI, ensuring commands always run from the backend/
# directory where alembic.ini and backend/.env are located.
# DB credentials are read from backend/.env via app settings — never
# from alembic.ini and never hardcoded here.
#
# Usage: ./migrate.sh <alembic-command> [args]
#
# Examples:
#   ./migrate.sh current
#   ./migrate.sh history --verbose
#   ./migrate.sh heads
#   ./migrate.sh upgrade --sql head        # preview SQL without executing
#   ./migrate.sh stamp 0001_baseline       # stamp existing DB to baseline (once)
#   ./migrate.sh upgrade head              # apply pending migrations
#   ./migrate.sh revision -m "add_col_x"  # create a new migration file
#
# Always take a mysqldump backup before running 'upgrade' on a real database.
# See docs/MIGRATIONS.md for full procedures.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec alembic "$@"
