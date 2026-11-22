<#
  重启桌面端 DSH（Windows）。

  为什么需要它：客户端插件包只在宿主启动时组装进 boot payload，改了
  client/client.js 之后必须重启宿主才能看到新面板；这一轮对话本身也跑在
  同一个宿主里，所以脚本故意延迟执行，让调用它的那一轮回复先落盘。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File bin\restart-dsh.ps1
    powershell ... -File bin\restart-dsh.ps1 -DelaySeconds 60

  安全边界：只结束主进程（命令行里没有 --type= 的那个），不按命令行子串乱杀；
  重启后自检进程，失败再补一次；全过程写 %TEMP%\dsh-restart.log。
#>
param([int]$DelaySeconds = 25)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dsh-restart.log'
function Say($message) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $message
  Write-Host $line
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

$exe = 'D:\software\dsh\DSH NEXT\DSH NEXT.exe'
if (-not (Test-Path -LiteralPath $exe)) { Say ('abort: ' + $exe + ' not found'); exit 1 }

Say ('waiting ' + $DelaySeconds + 's before restart')
Start-Sleep -Seconds $DelaySeconds

# 主进程没有 --type=，渲染/GPU/crashpad 都有
$mains = @(Get-CimInstance Win32_Process -Filter "Name='DSH NEXT.exe'" |
  Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' })
if ($mains.Count -eq 0) { Say 'no running main process; starting a fresh one' }
foreach ($p in $mains) { Say ('stopping pid ' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 4
Start-Process -FilePath $exe
Say 'relaunched'

$up = $false
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 5
  $main = @(Get-CimInstance Win32_Process -Filter "Name='DSH NEXT.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' })
  if ($main.Count -gt 0) { Say ('main process up: ' + $main[0].ProcessId); $up = $true; break }
}
if (-not $up) {
  Say 'relaunch did not come up; trying once more'
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 10
}

$webLine = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.dsh\logs\desktop-next.log') -Tail 200 -ErrorAction SilentlyContinue |
  Select-String -Pattern 'dsh web: http' | Select-Object -Last 1
if ($webLine) { Say ('last web url line: ' + $webLine.Line) } else { Say 'no web url line found in the log' }
Say 'done'
