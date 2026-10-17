param([string]$OutputDirectory = 'docs/evidence/m10-validation-logs')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$results = @()
& bun run typecheck *> (Join-Path $OutputDirectory 'typecheck.log')
$typecheckExit = $LASTEXITCODE
$results += [pscustomobject]@{ command = 'bun run typecheck'; exitCode = $typecheckExit; summary = @() }
Write-Output "typecheck: exit $typecheckExit"
$testFiles = @(& rg --files tests -g '*.test.ts' | Sort-Object)
foreach ($testFile in $testFiles) {
  $logName = ($testFile -replace '[\\/]', '_') + '.log'
  $logPath = Join-Path $OutputDirectory $logName
  & bun test $testFile --timeout 30000 *> $logPath
  $testExit = $LASTEXITCODE
  $summary = @(Get-Content $logPath | Where-Object { $_ -match '^\s*\d+ (pass|fail)$|^Ran \d+ tests? across' })
  $results += [pscustomobject]@{ command = "bun test $testFile --timeout 30000"; exitCode = $testExit; summary = $summary }
  Write-Output "$testFile : exit $testExit ; $($summary -join ' | ')"
}
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutputDirectory 'results.json')
if (@($results | Where-Object { $_.exitCode -ne 0 }).Count -gt 0) { exit 1 }
exit 0
