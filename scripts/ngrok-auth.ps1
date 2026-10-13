$ErrorActionPreference = 'Stop'
$ngrokRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'work/ngrok'
$ngrokPath = Join-Path $ngrokRoot 'ngrok.exe'
if (!(Test-Path -LiteralPath $ngrokPath)) {
    $ngrokPath = (Get-Command ngrok -ErrorAction Stop).Source
}
New-Item -ItemType Directory -Force -Path $ngrokRoot | Out-Null
$configPath = Join-Path $ngrokRoot 'ngrok.yml'
if (!(Test-Path -LiteralPath $configPath)) {
    [IO.File]::WriteAllText($configPath, "version: 3`nagent:`n  web_addr: false`n")
}
Write-Host 'Get your token from https://dashboard.ngrok.com/get-started/your-authtoken'
Write-Host 'Paste it into this hidden local prompt. It will not be printed or saved in shell history.'
$ngrokSecret = Read-Host 'ngrok authtoken' -AsSecureString
$ngrokPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ngrokSecret)
try {
    & $ngrokPath config add-authtoken ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ngrokPointer)) --config=$configPath --log=false *> $null
    if ($LASTEXITCODE -ne 0) { throw 'ngrok authentication configuration failed.' }
    Write-Host 'ngrok authentication configured locally.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ngrokPointer)
    $ngrokSecret.Dispose()
}
