# MangaSoft tray launcher: runs the server with no console window and lives in the system tray.
# Start it by double-clicking MangaSoft.vbs.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { [int]$env:PORT } else { 8484 }
$url = "http://localhost:$port"
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$logFile = Join-Path $dataDir 'server.log'

# only one tray at a time
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\MangaSoftTray', [ref]$created)
if (-not $created) { exit }

function Test-Server {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$url/healthz").StatusCode -eq 200 } catch { $false }
}

function Get-LanAddress {
  $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.ToString() }
  $pick = $ips | Where-Object { $_ -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object -First 1
  if ($pick) { "http://${pick}:$port" } else { $null }
}

$script:serverProc = $null
function Start-Server {
  if (Test-Server) { return }   # already running (e.g. started from start.bat)
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show('Node.js was not found. Install it from nodejs.org and try again.', 'MangaSoft') | Out-Null
    exit
  }
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm install' -WorkingDirectory $root -WindowStyle Hidden -Wait
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = "/c `"`"$node`" --no-warnings server/run.js >> `"$logFile`" 2>&1`""
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:serverProc = [System.Diagnostics.Process]::Start($psi)
}

function Stop-Server {
  if ($script:serverProc -and -not $script:serverProc.HasExited) {
    & taskkill.exe /PID $script:serverProc.Id /T /F | Out-Null
  }
  $script:serverProc = $null
}

# --- icon: a little pink blossom drawn at runtime ---
function New-BlossomIcon {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $petal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 106, 150))
  $center = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 240, 245))
  for ($i = 0; $i -lt 5; $i++) {
    $a = ($i * 72 - 90) * [Math]::PI / 180
    $cx = 16 + [Math]::Cos($a) * 8.5; $cy = 16 + [Math]::Sin($a) * 8.5
    $g.FillEllipse($petal, [single]($cx - 6.5), [single]($cy - 6.5), 13, 13)
  }
  $g.FillEllipse($center, 11, 11, 10, 10)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# --- start-with-Windows shortcut ---
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'MangaSoft.lnk'
function Set-Autostart([bool]$on) {
  if ($on) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($startupLink)
    $lnk.TargetPath = 'wscript.exe'
    $lnk.Arguments = "`"$(Join-Path $root 'MangaSoft.vbs')`""
    $lnk.WorkingDirectory = $root
    $lnk.Save()
  } elseif (Test-Path $startupLink) { Remove-Item $startupLink -Force }
}

# --- tray ---
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-BlossomIcon
$tray.Text = 'MangaSoft'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Open MangaSoft')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miCopy = $menu.Items.Add('Copy network address (for phone)')
$miScan = $menu.Items.Add('Rescan library')
$menu.Items.Add('-') | Out-Null
$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows'
$miAuto.CheckOnClick = $true
$miAuto.Checked = Test-Path $startupLink
$menu.Items.Add($miAuto) | Out-Null
$miLog = $menu.Items.Add('Open data folder')
$miRestart = $menu.Items.Add('Restart server')
$menu.Items.Add('-') | Out-Null
$miQuit = $menu.Items.Add('Quit MangaSoft')
$tray.ContextMenuStrip = $menu

$open = { Start-Process $url }
$miOpen.add_Click($open)
$tray.add_DoubleClick($open)
$miCopy.add_Click({
  $addr = Get-LanAddress
  if ($addr) {
    [System.Windows.Forms.Clipboard]::SetText($addr)
    $tray.ShowBalloonTip(3000, 'MangaSoft', "Copied $addr", 'Info')
  } else { $tray.ShowBalloonTip(3000, 'MangaSoft', 'No local network address found.', 'Warning') }
})
$miScan.add_Click({
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -ContentType 'application/json' -Body '{}' "$url/api/scan" | Out-Null
    $tray.ShowBalloonTip(2500, 'MangaSoft', 'Scanning your library…', 'Info')
  } catch { $tray.ShowBalloonTip(3000, 'MangaSoft', 'Server is not responding.', 'Error') }
})
$miAuto.add_Click({ Set-Autostart $miAuto.Checked })
$miLog.add_Click({ Start-Process explorer.exe $dataDir })
$miRestart.add_Click({
  Stop-Server
  Start-Sleep -Milliseconds 500
  Start-Server
  $tray.ShowBalloonTip(2500, 'MangaSoft', 'Server restarted.', 'Info')
})
$miQuit.add_Click({
  $tray.Visible = $false
  Stop-Server
  [System.Windows.Forms.Application]::Exit()
})

Start-Server

# announce once the server answers; warn if the process dies
$tries = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$announced = $false
$timer.add_Tick({
  if (-not $script:announced) {
    $script:tries++
    if (Test-Server) {
      $script:announced = $true
      $addr = Get-LanAddress
      $tray.Text = 'MangaSoft is running'
      $tray.ShowBalloonTip(5000, 'MangaSoft is running', ("On this PC: $url" + $(if ($addr) { "`nOn your phone: $addr" } else { '' })), 'Info')
    } elseif ($script:tries -gt 40) {
      $script:announced = $true
      $tray.ShowBalloonTip(6000, 'MangaSoft', "Server did not start. See data\server.log", 'Error')
    }
  } elseif ($script:serverProc -and $script:serverProc.HasExited) {
    $script:serverProc = $null
    $tray.Text = 'MangaSoft (stopped)'
    $tray.ShowBalloonTip(5000, 'MangaSoft', 'The server stopped. Use "Restart server" in the tray menu.', 'Warning')
  }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $tray.Visible = $false
  $tray.Dispose()
  Stop-Server
  $mutex.ReleaseMutex()
}
