# 找到 DSH 到底从哪个目录加载插件
# 用法：右键「使用 PowerShell 运行」，或 powershell -ExecutionPolicy Bypass -File .\find-dsh-plugins.ps1

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== 1. 常见插件目录是否存在 ===" -ForegroundColor Cyan
$candidates = @(
  "$env:USERPROFILE\.dsh\plugins",
  "$env:USERPROFILE\.dsh\node_modules",
  "$env:USERPROFILE\.dsh\extensions",
  "$env:APPDATA\@deepseek-ai\dsh-desktop\plugins",
  "$env:LOCALAPPDATA\@deepseek-ai\dsh-desktop\plugins",
  "E:\Deepseek harness\plugins",
  "E:\Deepseek harness\resources\plugins"
)
foreach ($p in $candidates) {
  if (Test-Path $p) {
    $n = (Get-ChildItem $p -Force | Measure-Object).Count
    Write-Host ("  [有] {0}   ({1} 项)" -f $p, $n) -ForegroundColor Green
  } else {
    Write-Host ("  [无] {0}" -f $p) -ForegroundColor DarkGray
  }
}

Write-Host "`n=== 2. 磁盘上已经存在的 DSH 插件（含 `"dsh`" 字段的 package.json）===" -ForegroundColor Cyan
$roots = @(
  "$env:USERPROFILE\.dsh",
  "$env:APPDATA\@deepseek-ai",
  "$env:LOCALAPPDATA\@deepseek-ai",
  "E:\Deepseek harness"
)
$found = @()
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  Get-ChildItem $r -Recurse -Depth 5 -Filter package.json -File |
    ForEach-Object {
      $t = Get-Content $_.FullName -Raw
      if ($t -match '"dsh"\s*:') {
        $found += $_.FullName
        Write-Host ("  [插件] {0}" -f $_.FullName) -ForegroundColor Yellow
      }
    }
}

if ($found.Count -eq 0) {
  Write-Host "  没找到任何第三方插件 —— 说明你还没装过，插件目录可能还不存在。" -ForegroundColor DarkYellow
}

Write-Host "`n=== 3. 谁在监听 58199（GUI 端口）===" -ForegroundColor Cyan
$conn = Get-NetTCPConnection -LocalPort 58199 -State Listen
if ($conn) {
  $proc = Get-Process -Id $conn.OwningProcess
  Write-Host ("  PID {0}  {1}" -f $proc.Id, $proc.Path) -ForegroundColor Green
  Write-Host ("  工作目录（插件可能相对它解析，仅供参考）: {0}" -f $proc.StartInfo.WorkingDirectory)
} else {
  Write-Host "  58199 没在监听（GUI 可能是别的端口）" -ForegroundColor DarkYellow
}

Write-Host "`n=== 4. 结论怎么用 ===" -ForegroundColor Cyan
Write-Host "  如果第 1 步有某个目录被标成 [有]，把 dsh-session-delete 文件夹整个复制进去，重启 DSH。"
Write-Host "  如果全是 [无]，就用第 2 步列出的插件所在目录——那批目录的上一级就是插件根。"
Write-Host "  把上面输出整段复制回来，我可以直接告诉你要放进哪个路径。"