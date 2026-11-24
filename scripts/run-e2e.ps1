# 一体化 E2E 驱动：单次执行内完成服务启动、浏览器测试、清理
$ErrorActionPreference = 'Continue'
$root = 'D:\codex\runs\15461\workspace'
Set-Location $root
Get-Process node,chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$port = 4600
$cdp = 9600
# 启动静态服务器（独立进程，通过 cmd 显式注入端口环境变量）
$env:PORT = "$port"
$srv = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","set PORT=$port&& node scripts/static-server.mjs" -WorkingDirectory $root -WindowStyle Hidden -PassThru

# 等待服务器
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing "http://localhost:$port/" -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch {}
  Start-Sleep -Milliseconds 300
}
if (-not $ready) { Write-Output 'SERVER_FAIL'; exit 1 }
# 关键：验证 worker chunk 可达
$wc = (Get-ChildItem "$root\dist\assets\analysis.worker-*.js" | Select-Object -First 1).Name
try {
  $wr = Invoke-WebRequest -UseBasicParsing "http://localhost:$port/assets/$wc" -TimeoutSec 5
  Write-Output "WORKER_HTTP $($wr.StatusCode) $($wr.Headers['Content-Type']) $($wr.RawContentLength)B"
} catch { Write-Output "WORKER_FETCH_FAIL $_" }

# 启动 Chrome
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
  "--remote-debugging-port=$cdp","--user-data-dir=$env:TEMP\cdp-driver-$([guid]::NewGuid())",`
  "--no-first-run","--no-default-browser-check","--autoplay-policy=no-user-gesture-required",`
  "--window-size=1400,1000","http://localhost:$port/"
Start-Sleep -Seconds 6

# 跑 E2E
$env:CDP_PORT = $cdp
$env:TARGET_URL = "http://localhost:$port/"
node scripts/e2e.mjs
$code = $LASTEXITCODE
Write-Output "E2E_EXIT $code"

# 清理
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
try { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue } catch {}
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue
exit $code
