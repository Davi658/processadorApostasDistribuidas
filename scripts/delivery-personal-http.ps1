param([string]$Api = 'http://127.0.0.1:3093')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Post([string]$Path, $Body, [string]$Key = '') {
  $headers = @{}; if ($Key) { $headers['idempotency-key'] = $Key }
  Invoke-WebRequest -Uri "$Api$Path" -Method Post -ContentType 'application/json' -Headers $headers -Body ($Body | ConvertTo-Json -Depth 10) -SkipHttpErrorCheck
}
New-Item -ItemType Directory -Force .data/personal | Out-Null
$player = [guid]::NewGuid().ToString()
$walletResponse = Post '/wallets' @{playerId=$player;initialBalance=@{amount='100.00';currency='BRL'}}
Check ($walletResponse.StatusCode -eq 201) 'Wallet creation failed'
$wallet = $walletResponse.Content | ConvertFrom-Json
$data = @{providerId='personal';externalTransactionId=[guid]::NewGuid().ToString();playerId=$player;walletId=$wallet.id;roundId='manual';gameId='manual';kind='BET';money=@{amount='10.00';currency='BRL'}}
$key = [guid]::NewGuid().ToString()
$firstResponse = Post '/wagering/transactions' $data $key
Check ($firstResponse.StatusCode -eq 200) 'BET failed'
$first = $firstResponse.Content | ConvertFrom-Json
$replay = (Post '/wagering/transactions' $data $key).Content | ConvertFrom-Json
Check ($replay.idempotentReplay -and $replay.transactionId -eq $first.transactionId) 'Replay differs'
$data.money.amount = '11.00'
Check ((Post '/wagering/transactions' $data $key).StatusCode -eq 409) 'Expected conflict 409'
$data.money.amount='5.00'; $data.externalTransactionId=[guid]::NewGuid().ToString()
$data.idempotencyKey = [guid]::NewGuid().ToString()
$command = @{messageId="personal-$([guid]::NewGuid())";type='WagerTransactionRequested';occurredAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');data=$data}
$command | ConvertTo-Json -Depth 10 | Set-Content .data/personal/command.json -Encoding utf8
$state = @{walletId=$wallet.id;playerId=$player;httpTransactionId=$first.transactionId;commandId=$command.messageId;externalTransactionId=$data.externalTransactionId}
$state | ConvertTo-Json | Set-Content .data/personal/state.json -Encoding utf8
Write-Host "HTTP OK: wallet=$($wallet.id), BET=$($first.transactionId), balance expected=90.00. SQS fixture saved in .data/personal/command.json"
