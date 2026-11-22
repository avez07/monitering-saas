# Opens Backend, Worker and Frontend, each in its own terminal window (or Windows Terminal tab).
# Usage (repo root):  powershell -ExecutionPolicy Bypass -File scripts/dev-terminals.ps1
$root = Split-Path -Parent $PSScriptRoot
$jobs = @(
  @{ Title = 'yuktiops-backend';  Cmd = 'npm run dev:backend' },
  @{ Title = 'yuktiops-worker';   Cmd = 'npm run dev:worker' },
  @{ Title = 'yuktiops-frontend'; Cmd = 'npm run dev:frontend' }
)
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
  $args = @()
  foreach ($j in $jobs) {
    if ($args.Count -gt 0) { $args += ';' }
    $args += @('new-tab', '--title', $j.Title, '-d', $root, 'powershell', '-NoExit', '-Command', $j.Cmd)
  }
  Start-Process wt.exe -ArgumentList $args
} else {
  foreach ($j in $jobs) {
    Start-Process powershell -WorkingDirectory $root -ArgumentList @('-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$($j.Title)'; $($j.Cmd)")
  }
}
