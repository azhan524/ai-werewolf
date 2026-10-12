// AI 狼人杀 —— Windows 桌面程序（单文件 exe）
// 界面用内嵌的 WebView2 承载，但外观就是一个普通桌面窗口：自己的图标、菜单栏、状态栏、任务栏项，
// 没有地址栏、没有标签页、也不会打开浏览器。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AiWerewolf
{
    internal static class Program
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string path);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main()
        {
            // 1) 先把 WebView2 的原生加载器释放出来（很小，毫秒级），再登记搜索路径，
            //    这样后面所有 WebView2 调用都能找到它。
            string runtimeDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AIWerewolf", "runtime");
            try
            {
                Directory.CreateDirectory(runtimeDir);
                string loader = Path.Combine(runtimeDir, "WebView2Loader.dll");
                Assembly self = Assembly.GetExecutingAssembly();
                using (Stream s = self.GetManifestResourceStream("native.WebView2Loader.x64.dll"))
                {
                    if (s != null)
                    {
                        byte[] bytes = new byte[s.Length];
                        int read = 0;
                        while (read < bytes.Length)
                        {
                            int n = s.Read(bytes, read, bytes.Length - read);
                            if (n <= 0) break;
                            read += n;
                        }
                        bool same = false;
                        try { same = File.Exists(loader) && new FileInfo(loader).Length == bytes.Length; } catch { }
                        if (!same) File.WriteAllBytes(loader, bytes);
                    }
                }
                SetDllDirectory(runtimeDir);
            }
            catch { }

            // 2) 内嵌的 WebView2 托管程序集也从 exe 里加载（保证单文件）
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbeddedAssembly;
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }

        private static Assembly ResolveEmbeddedAssembly(object sender, ResolveEventArgs args)
        {
            string simpleName = new AssemblyName(args.Name).Name;
            if (!simpleName.StartsWith("Microsoft.Web.WebView2", StringComparison.OrdinalIgnoreCase)) return null;
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("lib." + simpleName + ".dll"))
            {
                if (stream == null) return null;
                byte[] buffer = new byte[stream.Length];
                int read = 0;
                while (read < buffer.Length)
                {
                    int n = stream.Read(buffer, read, buffer.Length - read);
                    if (n <= 0) break;
                    read += n;
                }
                return Assembly.Load(buffer);
            }
        }
    }

    /// <summary>让 node 子进程随程序一起退出，不留后台残留</summary>
    internal static class JobRunner
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters { public ulong A, B, C, D, E, F; }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimit
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimit
        {
            public BasicLimit Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint KillOnJobClose = 0x2000;
        private static IntPtr _job = IntPtr.Zero;

        public static void Attach(Process process)
        {
            try
            {
                if (_job == IntPtr.Zero)
                {
                    _job = CreateJobObject(IntPtr.Zero, null);
                    if (_job == IntPtr.Zero) return;
                    ExtendedLimit info = new ExtendedLimit();
                    info.Basic.LimitFlags = KillOnJobClose;
                    int size = Marshal.SizeOf(typeof(ExtendedLimit));
                    IntPtr ptr = Marshal.AllocHGlobal(size);
                    try
                    {
                        Marshal.StructureToPtr(info, ptr, false);
                        SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ptr, (uint)size);
                    }
                    finally { Marshal.FreeHGlobal(ptr); }
                }
                AssignProcessToJobObject(_job, process.Handle);
            }
            catch { }
        }
    }

    public class MainForm : Form
    {
        private readonly WebView2 _web;
        private readonly MenuStrip _menu;
        private readonly TextBox _logBox;
        private readonly Form _logForm;

        private Process _node;
        private int _port = 8789;
        private string _rootDir;
        private string _appDir;
        private string _dataDir;
        private string _runtimeDir;
        private volatile bool _closing;
        private bool _webReady;
        private bool _fullScreen;
        private FormBorderStyle _oldBorder;
        private bool _oldMaximized;

        public MainForm()
        {
            Text = "AI 狼人杀";
            AutoScaleMode = AutoScaleMode.None;
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(245, 246, 248);
            // 按屏幕工作区决定初始大小（考虑 150% 这类缩放，保证三栏布局能展开）
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int winW = Math.Max(1100, Math.Min(1760, (int)(wa.Width * 0.9)));
            int winH = Math.Max(700, Math.Min(1160, (int)(wa.Height * 0.9)));
            ClientSize = new Size(winW, winH);
            MinimumSize = new Size(880, 560);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // ---- 内核控件（Dock 顺序：先加的 Fill 控件最后布局，才能正确避让菜单/状态栏）----
            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);

            // ---- 菜单栏 ----
            _menu = new MenuStrip();
            ToolStripMenuItem fileMenu = new ToolStripMenuItem("文件(&F)");
            fileMenu.DropDownItems.Add(MakeItem("打开数据文件夹", delegate { OpenFolder(); }));
            fileMenu.DropDownItems.Add(MakeItem("在浏览器中打开", delegate { OpenBrowser(); }));
            fileMenu.DropDownItems.Add(new ToolStripSeparator());
            fileMenu.DropDownItems.Add(MakeItem("退出", delegate { Close(); }));
            ToolStripMenuItem viewMenu = new ToolStripMenuItem("视图(&V)");
            viewMenu.DropDownItems.Add(MakeItem("重新加载", delegate { Reload(); }));
            viewMenu.DropDownItems.Add(new ToolStripSeparator());
            viewMenu.DropDownItems.Add(MakeItem("放大", delegate { Zoom(0.1); }));
            viewMenu.DropDownItems.Add(MakeItem("缩小", delegate { Zoom(-0.1); }));
            viewMenu.DropDownItems.Add(MakeItem("实际大小", delegate { Zoom(0); }));
            viewMenu.DropDownItems.Add(new ToolStripSeparator());
            viewMenu.DropDownItems.Add(MakeItem("全屏", delegate { ToggleFullScreen(); }));
            ToolStripMenuItem helpMenu = new ToolStripMenuItem("帮助(&H)");
            helpMenu.DropDownItems.Add(MakeItem("查看运行日志", delegate { ShowLog(); }));
            helpMenu.DropDownItems.Add(MakeItem("关于", delegate { ShowAbout(); }));
            _menu.Items.Add(fileMenu);
            _menu.Items.Add(viewMenu);
            _menu.Items.Add(helpMenu);
            MainMenuStrip = _menu;
            Controls.Add(_menu);

            // ---- 日志窗口 ----
            _logBox = new TextBox();
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.Dock = DockStyle.Fill;
            _logBox.ScrollBars = ScrollBars.Both;
            _logBox.WordWrap = false;
            _logBox.BackColor = Color.FromArgb(28, 30, 36);
            _logBox.ForeColor = Color.FromArgb(220, 222, 226);
            _logBox.Font = new Font("Consolas", 8.5F);
            _logForm = new Form();
            _logForm.Text = "运行日志";
            _logForm.ClientSize = new Size(780, 440);
            _logForm.StartPosition = FormStartPosition.CenterParent;
            _logForm.Controls.Add(_logBox);
            try { _logForm.Icon = Icon; } catch { }

            Load += async delegate { await RunAsync(); };
            FormClosing += OnFormClosing;
        }

        private static ToolStripMenuItem MakeItem(string text, EventHandler handler)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.Click += handler;
            return item;
        }

        private string Url() { return "http://127.0.0.1:" + _port + "/"; }

        // ---------------- 界面小工具 ----------------
        private void Ui(Action action)
        {
            if (_closing) return;
            try { BeginInvoke((MethodInvoker)delegate { action(); }); } catch { }
        }

        private void SetStatus(string text)
        {
            Ui(delegate
            {
                Text = string.IsNullOrEmpty(text) ? "AI 狼人杀" : "AI 狼人杀 · " + text;
            });
        }

        private void AppendLog(string line)
        {
            Ui(delegate
            {
                if (_logBox.Lines.Length > 800)
                {
                    string[] lines = _logBox.Lines;
                    _logBox.Text = string.Join(Environment.NewLine, lines, lines.Length - 400, 400);
                }
                _logBox.AppendText(line + Environment.NewLine);
                _logBox.SelectionStart = _logBox.TextLength;
                _logBox.ScrollToCaret();
            });
        }

        // ---------------- 启动流程（全部在 UI 线程调度，WebView2 调用必须在 UI 线程）----------------
        private async Task RunAsync()
        {
            try
            {
                bool forceBrowser = Environment.GetEnvironmentVariable("WEREWOLF_FORCE_BROWSER") == "1";

                await Task.Run((Action)PrepareFiles);

                if (forceBrowser)
                {
                    await Task.Run((Action)StartServerBlocking);
                    Ui(delegate
                    {
                        SetStatus("运行中（浏览器模式）");
                        OpenBrowser();
                        MessageBox.Show(this, "已用浏览器打开：" + Url(), "AI 狼人杀",
                            MessageBoxButtons.OK, MessageBoxIcon.Information);
                    });
                    return;
                }

                string runtimeVersion = null;
                try { runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
                if (string.IsNullOrEmpty(runtimeVersion))
                {
                    AppendLog("[程序] 未检测到 WebView2 运行时，改用浏览器显示");
                    await Task.Run((Action)StartServerBlocking);
                    Ui(delegate
                    {
                        SetStatus("运行中（浏览器模式）");
                        OpenBrowser();
                        MessageBox.Show(this,
                            "这台电脑缺少 WebView2 运行时，已改用浏览器显示界面：\n" + Url(),
                            "AI 狼人杀", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    });
                    return;
                }
                AppendLog("[程序] WebView2 运行时 " + runtimeVersion);

                await InitWebViewAsync();          // UI 线程
                ShowLoadingPage();

                await Task.Run((Action)StartServerBlocking);
                NavigateApp();
            }
            catch (Exception ex)
            {
                AppendLog("[错误] " + ex);
                SetStatus("启动失败");
                Ui(delegate
                {
                    ShowLog();
                    MessageBox.Show(this,
                        "启动失败：" + ex.Message + "\n\n详情见「帮助 → 查看运行日志」。",
                        "AI 狼人杀", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
                KillNode();
            }
        }

        private void PrepareFiles()
        {
            _rootDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AIWerewolf");
            _runtimeDir = Path.Combine(_rootDir, "runtime");
            _appDir = Path.Combine(_rootDir, "app-" + EmbeddedApp.BuildId);
            _dataDir = Path.Combine(_rootDir, "data");
            Directory.CreateDirectory(_runtimeDir);
            Directory.CreateDirectory(_dataDir);
            Directory.CreateDirectory(Path.Combine(_rootDir, "webview"));

            int preferred = 8789;
            string envPort = Environment.GetEnvironmentVariable("WEREWOLF_PORT");
            int parsed;
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out parsed) && parsed > 0) preferred = parsed;

            AppendLog("[程序] 版本 " + EmbeddedApp.BuildId);
            AppendLog("[程序] 数据目录 " + _dataDir);

            if (IsOursAlive(preferred))
            {
                _port = preferred;
                AppendLog("[程序] 检测到服务已在运行，直接接入");
                return;
            }
            ExtractRuntime();
            ExtractApp();
            _port = FindFreePort(preferred);
            if (_port == 0) throw new Exception("找不到可用的本地端口");
        }

        private void ExtractRuntime()
        {
            string nodePath = Path.Combine(_runtimeDir, "node.exe");
            string marker = Path.Combine(_runtimeDir, "runtime.ok");
            if (File.Exists(nodePath) && File.Exists(marker)) return;

            SetStatus("首次启动：正在释放运行环境…");
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream raw = asm.GetManifestResourceStream(EmbeddedApp.NodeResource))
            {
                if (raw == null) throw new Exception("安装包不完整：缺少内嵌运行时");
                if (File.Exists(nodePath)) File.Delete(nodePath);
                using (GZipStream gz = new GZipStream(raw, CompressionMode.Decompress))
                using (FileStream fs = File.Create(nodePath))
                {
                    byte[] buffer = new byte[1024 * 256];
                    int read;
                    long total = 0;
                    while ((read = gz.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        fs.Write(buffer, 0, read);
                        total += read;
                    }
                    AppendLog(string.Format("[程序] 已释放 node.exe（{0:F1} MB）", total / 1048576.0));
                }
            }
            File.WriteAllText(marker, EmbeddedApp.BuildId);
        }

        private void ExtractApp()
        {
            string marker = Path.Combine(_appDir, ".ok");
            if (File.Exists(marker)) return;
            if (Directory.Exists(_appDir)) Directory.Delete(_appDir, true);
            Directory.CreateDirectory(_appDir);
            EmbeddedApp.Extract(_appDir);
            File.WriteAllText(marker, EmbeddedApp.BuildId);
            AppendLog("[程序] 已释放程序文件到 " + _appDir);
        }

        private void StartServerBlocking()
        {
            if (IsOursAlive(_port))
            {
                AppendLog("[程序] 复用已在运行的服务 " + Url());
                return;
            }
            SetStatus("正在启动本地服务…");
            string nodePath = Path.Combine(_runtimeDir, "node.exe");
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = nodePath;
            info.Arguments = "server.js";
            info.WorkingDirectory = _appDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["PORT"] = _port.ToString();
            info.EnvironmentVariables["HOST"] = "127.0.0.1";
            info.EnvironmentVariables["DATA_FILE"] = Path.Combine(_dataDir, "db.json");
            info.EnvironmentVariables["BUILD_ID"] = EmbeddedApp.BuildId;

            _node = new Process();
            _node.StartInfo = info;
            _node.EnableRaisingEvents = true;
            _node.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog(e.Data); };
            _node.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog("[stderr] " + e.Data); };
            _node.Exited += delegate { if (!_closing) SetStatus("服务已退出（帮助 → 查看运行日志）"); };
            _node.Start();
            _node.BeginOutputReadLine();
            _node.BeginErrorReadLine();
            JobRunner.Attach(_node);

            if (!WaitForReady(30000)) throw new Exception("本地服务启动超时（30 秒）");
            AppendLog("[程序] 服务就绪 " + Url());
        }

        private bool WaitForReady(int timeoutMs)
        {
            DateTime deadline = DateTime.Now.AddMilliseconds(timeoutMs);
            while (DateTime.Now < deadline)
            {
                if (_node != null && _node.HasExited) return false;
                string body = HttpGet(string.Format("http://127.0.0.1:{0}/api/state", _port), 900);
                if (body != null && body.Contains("\"agents\"")) return true;
                Thread.Sleep(250);
            }
            return false;
        }

        private bool IsOursAlive(int port)
        {
            string body = HttpGet(string.Format("http://127.0.0.1:{0}/api/state", port), 700);
            if (body == null) return false;
            Match m = Regex.Match(body, "\"buildId\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success && m.Groups[1].Value == EmbeddedApp.BuildId;
        }

        private static string HttpGet(string url, int timeoutMs)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.Timeout = timeoutMs;
                request.ReadWriteTimeout = timeoutMs;
                request.Proxy = null;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (Stream stream = response.GetResponseStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch { return null; }
        }

        private static int FindFreePort(int start)
        {
            for (int port = start; port < start + 60; port++)
            {
                TcpListener listener = null;
                try
                {
                    listener = new TcpListener(IPAddress.Loopback, port);
                    listener.Start();
                    listener.Stop();
                    return port;
                }
                catch
                {
                    if (listener != null) { try { listener.Stop(); } catch { } }
                }
            }
            return 0;
        }

        // ---------------- WebView2 ----------------
        private async Task InitWebViewAsync()
        {
            try { CoreWebView2Environment.SetLoaderDllFolderPath(_runtimeDir); } catch { }
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(_rootDir, "webview"), null);
            await _web.EnsureCoreWebView2Async(environment);

            CoreWebView2Settings settings = _web.CoreWebView2.Settings;
            settings.AreDefaultContextMenusEnabled = true;
            settings.AreDevToolsEnabled = true;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = true;
            settings.AreBrowserAcceleratorKeysEnabled = true;

            _web.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (!e.IsSuccess) AppendLog("[程序] 界面加载失败：" + e.WebErrorStatus);
            };
            _web.CoreWebView2.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs e)
            {
                AppendLog("[程序] 界面进程异常：" + e.ProcessFailedKind);
            };
            // 界面里的外链（比如"去申请 API Key"）一律用系统默认浏览器打开，别把应用窗口导航走
            _web.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { Process.Start(e.Uri); } catch { }
            };
            _webReady = true;
        }

        private void ShowLoadingPage()
        {
            if (!_webReady) return;
            _web.CoreWebView2.NavigateToString(
                "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><style>" +
                "html,body{height:100%;margin:0;font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;" +
                "background:#f5f6f8;color:#1a1a1a;display:flex;align-items:center;justify-content:center}" +
                ".box{text-align:center}" +
                ".logo{width:76px;height:76px;border-radius:20px;background:#07c160;margin:0 auto 22px;" +
                "display:flex;align-items:center;justify-content:center;font-size:40px;box-shadow:0 6px 20px rgba(7,193,96,.35)}" +
                "h1{font-size:22px;margin:0 0 10px}p{color:#8a8a8a;margin:0;font-size:13px}" +
                ".bar{width:220px;height:4px;border-radius:2px;background:#e6e6e6;margin:22px auto 0;overflow:hidden}" +
                ".bar i{display:block;width:40%;height:100%;border-radius:2px;background:#07c160;animation:run 1.1s ease-in-out infinite}" +
                "@keyframes run{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}" +
                "</style></head><body><div class='box'><div class='logo'>🐺</div>" +
                "<h1>AI 狼人杀</h1><p>正在启动游戏服务…</p><div class='bar'><i></i></div></div></body></html>");
        }

        private void NavigateApp()
        {
            SetStatus("运行中");
            if (_webReady)
            {
                _web.CoreWebView2.Navigate(Url());
            }
        }

        private void Reload()
        {
            if (_webReady && _web.CoreWebView2 != null) _web.CoreWebView2.Reload();
        }

        private void Zoom(double delta)
        {
            if (!_webReady || _web.CoreWebView2 == null) return;
            double next = delta == 0 ? 1.0 : Math.Max(0.5, Math.Min(3.0, _web.ZoomFactor + delta));
            _web.ZoomFactor = next;
        }

        private void ToggleFullScreen()
        {
            if (!_fullScreen)
            {
                _oldBorder = FormBorderStyle;
                _oldMaximized = WindowState == FormWindowState.Maximized;
                _menu.Visible = false;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                Bounds = Screen.FromControl(this).Bounds;
                _fullScreen = true;
            }
            else
            {
                FormBorderStyle = _oldBorder;
                _menu.Visible = true;
                WindowState = _oldMaximized ? FormWindowState.Maximized : FormWindowState.Normal;
                _fullScreen = false;
            }
        }

        private void ShowLog()
        {
            if (!_logForm.Visible) _logForm.Show(this);
            else _logForm.BringToFront();
        }

        private void ShowAbout()
        {
            MessageBox.Show(this,
                "AI 狼人杀 · 主持人控制台\n\n" +
                "你是主持人：只负责点按钮推进流程，不参与游戏。\n" +
                "多个 AI 扮演玩家，在彼此隔离的频道里完成整局狼人杀。\n\n" +
                "版本：" + EmbeddedApp.BuildId + "\n" +
                "数据目录：" + (_dataDir ?? "-") + "\n" +
                "服务地址：" + Url() + "\n\n" +
                "所有数据只保存在本机，API Key 不会发送到任何第三方。",
                "关于", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OpenBrowser()
        {
            try { Process.Start(Url()); }
            catch (Exception ex) { AppendLog("[程序] 打开浏览器失败：" + ex.Message); }
        }

        private void OpenFolder()
        {
            try
            {
                if (_dataDir != null && Directory.Exists(_dataDir)) Process.Start("explorer.exe", "\"" + _dataDir + "\"");
            }
            catch { }
        }

        private void KillNode()
        {
            try { if (_node != null && !_node.HasExited) _node.Kill(); } catch { }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            _closing = true;
            KillNode();
        }
    }
}
