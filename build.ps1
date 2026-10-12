# 把整个应用 + Node 运行时打包成单个 Windows exe（构建脚本，使用者不需要运行它）
# 依赖：系统自带 csc.exe（.NET Framework 4.x）
$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$buildDir = Join-Path $root 'build'
$stageDir = Join-Path $buildDir 'stage'
$distDir  = Join-Path $root 'dist'
$exeName  = 'AI狼人杀.exe'
$outExe   = Join-Path $distDir $exeName

Write-Host '=== 1/6 准备目录 ===' -ForegroundColor Cyan
foreach ($d in @($buildDir, $stageDir, $distDir)) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

Write-Host '=== 2/6 收集要内嵌的应用文件 ===' -ForegroundColor Cyan
$appFiles = @()
$appFiles += Get-ChildItem -Path (Join-Path $root 'lib') -Filter '*.js' -File
$appFiles += Get-ChildItem -Path (Join-Path $root 'public') -File
$appFiles += @(Get-Item (Join-Path $root 'server.js'))
$appFiles += @(Get-Item (Join-Path $root 'package.json'))
if (Test-Path (Join-Path $root 'README.md')) { $appFiles += @(Get-Item (Join-Path $root 'README.md')) }

# 内置 undici：只为了 ProxyAgent（Node 的 fetch 不认系统代理，必须自己包 dispatcher）
$undici = Join-Path $root 'node_modules\undici'
if (-not (Test-Path $undici)) {
  throw "缺少 node_modules\undici —— 代理功能依赖它，请先在项目目录执行：npm install undici@6"
}
$undiciFiles = Get-ChildItem -Path $undici -Recurse -File | Where-Object { $_.Extension -in '.js', '.json' }
$appFiles += $undiciFiles
Write-Host "    内置 undici 文件数：$($undiciFiles.Count)"

# 计算内容指纹作为版本号（内容不变则同一版本，可复用解压结果）
$sb = New-Object System.Text.StringBuilder
foreach ($f in ($appFiles | Sort-Object FullName)) {
  $rel = $f.FullName.Substring($root.Length).TrimStart('\')
  [void]$sb.Append($rel).Append(':').Append($f.Length).Append(':')
  [void]$sb.Append((Get-FileHash $f.FullName -Algorithm MD5).Hash).Append(';')
}
$md5 = [System.Security.Cryptography.MD5]::Create()
$buildId = ([System.BitConverter]::ToString($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString())))).Replace('-', '').Substring(0, 12).ToLower()
Write-Host "    版本号：$buildId  文件数：$($appFiles.Count)"

Write-Host '=== 3/6 准备 WebView2 SDK ===' -ForegroundColor Cyan
$vendor = Join-Path $root 'vendor\webview2'
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
$wvFiles = @{
  'Microsoft.Web.WebView2.Core.dll'     = 'lib/net462/Microsoft.Web.WebView2.Core.dll'
  'Microsoft.Web.WebView2.WinForms.dll' = 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
  'WebView2Loader.x64.dll'              = 'runtimes/win-x64/native/WebView2Loader.dll'
}
$missing = @($wvFiles.Keys | Where-Object { -not (Test-Path (Join-Path $vendor $_)) })
if ($missing.Count -gt 0) {
  Write-Host "    缺少 $($missing -join ', ')，正在从 nuget.org 下载 SDK…"
  $idx = Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json' -TimeoutSec 60
  $ver = ($idx.versions | Where-Object { $_ -notmatch '-' } | Select-Object -Last 1)
  $nupkg = Join-Path $stageDir 'webview2.nupkg'
  Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$ver/microsoft.web.webview2.$ver.nupkg" -OutFile $nupkg -TimeoutSec 300 -UseBasicParsing
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
  try {
    foreach ($e in $zip.Entries) {
      foreach ($k in $wvFiles.Keys) {
        if ($e.FullName -eq $wvFiles[$k]) {
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $vendor $k), $true)
        }
      }
    }
  } finally { $zip.Dispose() }
  Write-Host "    WebView2 SDK $ver 已就绪"
} else {
  Write-Host '    已存在，跳过下载'
}

Write-Host '=== 4/6 压缩内嵌的 Node 运行时 ===' -ForegroundColor Cyan
$nodeExe = (Get-Command node).Source
$nodeGz  = Join-Path $stageDir 'node.exe.gz'
$in  = [System.IO.File]::OpenRead($nodeExe)
$out = [System.IO.File]::Create($nodeGz)
$gz  = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
try { $in.CopyTo($gz) } finally { $gz.Close(); $out.Close(); $in.Close() }
Write-Host ("    node.exe {0:N0} MB -> {1:N0} MB" -f ((Get-Item $nodeExe).Length / 1MB), ((Get-Item $nodeGz).Length / 1MB))

Write-Host '=== 5/6 生成程序图标 ===' -ForegroundColor Cyan
$iconPath = Join-Path $stageDir 'app.ico'
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
# 深夜色圆角底
$night = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 33, 46))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($night, $path)
# 月亮
$moon = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 246, 226, 154))
$g.FillEllipse($moon, 170, 30, 48, 48)
# 狼头剪影：两只耳朵 + 头 + 下巴
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillPolygon($white, @(
  (New-Object System.Drawing.PointF(74, 104)),
  (New-Object System.Drawing.PointF(98, 52)),
  (New-Object System.Drawing.PointF(124, 106))
))
$g.FillPolygon($white, @(
  (New-Object System.Drawing.PointF(182, 104)),
  (New-Object System.Drawing.PointF(158, 52)),
  (New-Object System.Drawing.PointF(132, 106))
))
$g.FillEllipse($white, 68, 88, 120, 96)
$g.FillPolygon($white, @(
  (New-Object System.Drawing.PointF(102, 150)),
  (New-Object System.Drawing.PointF(154, 150)),
  (New-Object System.Drawing.PointF(128, 202))
))
# 眼睛
$eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 33, 46))
$g.FillEllipse($eye, 98, 116, 20, 15)
$g.FillEllipse($eye, 138, 116, 20, 15)
$g.Dispose()
$pngPath = Join-Path $stageDir 'icon.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
# 打包成 ICO（PNG 载荷，Vista+ 支持）
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$fs = [System.IO.File]::Create($iconPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
$bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
$bw.Write([UInt16]1); $bw.Write([UInt16]32)
$bw.Write([UInt32]$pngBytes.Length); $bw.Write([UInt32]22)
$bw.Write($pngBytes)
$bw.Close(); $fs.Close()
Write-Host "    图标已生成：$iconPath"

Write-Host '=== 6/6 生成内嵌文件清单 ===' -ForegroundColor Cyan
$gen = New-Object System.Text.StringBuilder
[void]$gen.AppendLine('// <auto-generated> 由 build.ps1 生成，请勿手改 </auto-generated>')
[void]$gen.AppendLine('using System.IO;')
[void]$gen.AppendLine('using System.Reflection;')
[void]$gen.AppendLine('')
[void]$gen.AppendLine('internal static class EmbeddedApp')
[void]$gen.AppendLine('{')
[void]$gen.AppendLine("    public const string BuildId = `"$buildId`";")
[void]$gen.AppendLine('    public const string NodeResource = "node.exe.gz";')
[void]$gen.AppendLine('    public static void Extract(string appDir)')
[void]$gen.AppendLine('    {')
foreach ($f in ($appFiles | Sort-Object FullName)) {
  $rel = $f.FullName.Substring($root.Length).TrimStart('\')
  $relPosix = $rel -replace '\\', '/'
  $res = 'app.' + ($rel -replace '[\\/]', '.')
  [void]$gen.AppendLine("        ExtractFile(appDir, `"$relPosix`", `"$res`");")
}
[void]$gen.AppendLine('    }')
[void]$gen.AppendLine('    private static void ExtractFile(string appDir, string rel, string res)')
[void]$gen.AppendLine('    {')
[void]$gen.AppendLine('        string dst = Path.Combine(appDir, rel.Replace(''/'', Path.DirectorySeparatorChar));')
[void]$gen.AppendLine('        Directory.CreateDirectory(Path.GetDirectoryName(dst));')
[void]$gen.AppendLine('        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(res))')
[void]$gen.AppendLine('        {')
[void]$gen.AppendLine('            if (s == null) throw new IOException("缺少内嵌文件：" + res);')
[void]$gen.AppendLine('            using (FileStream f = File.Create(dst)) { s.CopyTo(f); }')
[void]$gen.AppendLine('        }')
[void]$gen.AppendLine('    }')
[void]$gen.AppendLine('}')
$genPath = Join-Path $stageDir 'EmbeddedApp.g.cs'
[System.IO.File]::WriteAllText($genPath, $gen.ToString(), (New-Object System.Text.UTF8Encoding($true)))

Write-Host '=== 6/6 编译 exe（内嵌运行时，需要一点时间）===' -ForegroundColor Cyan
$fw  = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 C# 编译器：$csc" }

$cscArgs = @(
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
  "/out:$outExe",
  "/win32icon:$iconPath",
  "/reference:$fw\System.dll",
  "/reference:$fw\System.Core.dll",
  "/reference:$fw\System.Drawing.dll",
  "/reference:$fw\System.Windows.Forms.dll",
  "/reference:$fw\System.IO.Compression.dll",
  "/reference:$vendor\Microsoft.Web.WebView2.Core.dll",
  "/reference:$vendor\Microsoft.Web.WebView2.WinForms.dll",
  "/resource:$nodeGz,node.exe.gz",
  "/resource:$vendor\Microsoft.Web.WebView2.Core.dll,lib.Microsoft.Web.WebView2.Core.dll",
  "/resource:$vendor\Microsoft.Web.WebView2.WinForms.dll,lib.Microsoft.Web.WebView2.WinForms.dll",
  "/resource:$vendor\WebView2Loader.x64.dll,native.WebView2Loader.x64.dll"
)
foreach ($f in ($appFiles | Sort-Object FullName)) {
  $rel = $f.FullName.Substring($root.Length).TrimStart('\')
  $res = 'app.' + ($rel -replace '[\\/]', '.')
  $cscArgs += "/resource:$($f.FullName),$res"
}
$cscArgs += (Join-Path $root 'launcher.cs')
$cscArgs += $genPath

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "编译失败（退出码 $LASTEXITCODE）" }

$exe = Get-Item $outExe
Write-Host ''
Write-Host ("构建完成 ✅  {0}" -f $exe.FullName) -ForegroundColor Green
Write-Host ("    大小：{0:N1} MB" -f ($exe.Length / 1MB))
Write-Host ("    版本：{0}" -f $buildId)
