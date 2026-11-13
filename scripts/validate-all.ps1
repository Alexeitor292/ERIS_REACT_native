Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Validating backend..."
python -m py_compile backend/app/main.py

Write-Host "Validating web..."
npx --prefix web tsc -p web/tsconfig.json --noEmit

Write-Host "Swift validation runs in .github/workflows/ios.yml (ERISKit + Xcode)."

Write-Host "All validations passed."
