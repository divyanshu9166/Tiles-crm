# Keeps the local LiveKit worker alive across transient crashes and reconnects.
# Run directly for diagnostics, or use scripts\install-calling-agent-task.ps1
# to start it automatically when this Windows user signs in.
$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = 'C:\Users\divya\Desktop\calling agent latest\venv\Scripts\python.exe'
$agentPath = Join-Path $projectRoot 'ai-agent\agent.py'
$logDir = Join-Path $env:LOCALAPPDATA 'TilesCRM'
$logPath = Join-Path $logDir 'calling-agent.log'

if (-not (Test-Path -LiteralPath $pythonPath)) { throw "Calling-agent Python runtime was not found: $pythonPath" }
if (-not (Test-Path -LiteralPath $agentPath)) { throw "Calling-agent source was not found: $agentPath" }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

while ($true) {
  "$(Get-Date -Format o) Starting AI calling worker" | Add-Content -LiteralPath $logPath
  & $pythonPath $agentPath start *>> $logPath
  "$(Get-Date -Format o) AI calling worker exited; restarting in 5 seconds" | Add-Content -LiteralPath $logPath
  Start-Sleep -Seconds 5
}
