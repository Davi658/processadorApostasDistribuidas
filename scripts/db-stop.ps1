$pgBin = Join-Path $env:USERPROFILE ".pgsql\pgsql\bin"
$dataDir = Join-Path $env:USERPROFILE ".pgsql_data"

if (Test-Path $dataDir) {
    Write-Host "Stopping PostgreSQL server..."
    & (Join-Path $pgBin "pg_ctl.exe") -D $dataDir stop
}
