$pgBin = Join-Path $env:USERPROFILE ".pgsql\pgsql\bin"
$dataDir = Join-Path $env:USERPROFILE ".pgsql_data"

if (-not (Test-Path $dataDir)) {
    Write-Host "Initializing PostgreSQL cluster at $dataDir..."
    & (Join-Path $pgBin "initdb.exe") -D $dataDir -U postgres -A trust -E UTF8
}

Write-Host "Starting PostgreSQL server..."
& (Join-Path $pgBin "pg_ctl.exe") -D $dataDir -l (Join-Path $dataDir "server.log") start

Start-Sleep -Seconds 2

Write-Host "Checking readiness..."
& (Join-Path $pgBin "pg_isready.exe") -U postgres -h localhost -p 5432

Write-Host "Ensuring betting_db exists..."
& (Join-Path $pgBin "psql.exe") -U postgres -h localhost -p 5432 -c "SELECT 1 FROM pg_database WHERE datname = 'betting_db'" | Out-Null
$dbExists = & (Join-Path $pgBin "psql.exe") -U postgres -h localhost -p 5432 -t -A -c "SELECT 1 FROM pg_database WHERE datname = 'betting_db'"
if ($dbExists -ne "1") {
    & (Join-Path $pgBin "createdb.exe") -U postgres -h localhost -p 5432 betting_db
}

Write-Host "Running init-db.sql..."
& (Join-Path $pgBin "psql.exe") -U postgres -h localhost -p 5432 -d betting_db -f (Join-Path $PSScriptRoot "init-db.sql")

Write-Host "PostgreSQL is running and ready for tests!"
