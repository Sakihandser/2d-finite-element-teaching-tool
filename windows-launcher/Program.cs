using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("TENSORA")]
[assembly: AssemblyProduct("TENSORA")]
[assembly: AssemblyDescription("Browser application launcher and local server owner")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace FemDesktop {
    public sealed class BrowserSpec {
        public string Name, Path;
        public BrowserSpec(string name, string path) { Name = name; Path = path; }
    }
    public static class Launcher {
        public static string Quote(string value) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public static string InstallationId(string root) {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(
                Encoding.UTF8.GetBytes(System.IO.Path.GetFullPath(root).TrimEnd('\\', '/').ToUpperInvariant())))
                .Replace("-", "").Substring(0, 20);
        }
        public static BrowserSpec SelectBrowser(List<BrowserSpec> browsers, string defaultId) {
            string preferred = (defaultId ?? "").StartsWith("MSEdge", StringComparison.OrdinalIgnoreCase) ? "Edge" : "Chrome";
            foreach (var browser in browsers) if (browser.Name == preferred) return browser;
            return browsers.Count == 0 ? null : browsers[0];
        }
        public static List<BrowserSpec> FindBrowsers() {
            var result = new List<BrowserSpec>();
            foreach (string executable in new[] { "chrome.exe", "msedge.exe" }) {
                string name = executable == "chrome.exe" ? "Chrome" : "Edge";
                var candidates = new List<string>();
                foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
                    using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + executable))
                        if (key != null) candidates.Add(Convert.ToString(key.GetValue(null)).Trim('"'));
                }
                foreach (string folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
                    candidates.Add(System.IO.Path.Combine(folder, name == "Chrome" ? @"Google\Chrome\Application\chrome.exe" : @"Microsoft\Edge\Application\msedge.exe"));
                foreach (string candidate in candidates) if (File.Exists(candidate)) { result.Add(new BrowserSpec(name, candidate)); break; }
            }
            return result;
        }
        public static string DefaultBrowserId() {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"))
                return key == null ? "" : Convert.ToString(key.GetValue("ProgId"));
        }
        public static string BrowserArguments(string url, string profile) {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.AbsolutePath != "/" || uri.Query != "" || uri.Fragment != "" || uri.UserInfo != "")
                throw new ArgumentException("启动器只允许打开本机计算服务。");
            return "--no-first-run --no-default-browser-check --disable-background-mode " +
                Quote("--user-data-dir=" + profile) + " " + Quote("--app=" + uri.AbsoluteUri);
        }
        public static bool TryReady(string line, int pid, out string url, out int port) {
            url = null; port = 0;
            const string prefix = "FEM_DESKTOP_READY ";
            if (line == null || !line.StartsWith(prefix, StringComparison.Ordinal)) return false;
            try {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line.Substring(prefix.Length));
                if (Convert.ToInt32(data["pid"]) != pid) return false;
                port = Convert.ToInt32(data["port"]); url = Convert.ToString(data["url"]);
                if (port < 1 || port > 65535 || url != "http://127.0.0.1:" + port + "/") { url = null; return false; }
                return true;
            } catch { url = null; port = 0; return false; }
        }

        [STAThread]
        public static int Main(string[] args) {
            Application.EnableVisualStyles();
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string id = InstallationId(root);
            string state = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FemDesktop", id);
            try {
                Directory.CreateDirectory(state);
                if (args.Length == 2 && args[0] == "--diagnose") {
                    var selected = SelectBrowser(FindBrowsers(), DefaultBrowserId());
                    File.WriteAllText(args[1], new JavaScriptSerializer().Serialize(new {
                        root, state, browser = selected == null ? null : selected.Name,
                        browserPath = selected == null ? null : selected.Path,
                        node = System.IO.Path.Combine(root, @"node-v24.21.0-win-x64\node.exe") }), Encoding.UTF8);
                    return 0;
                }
                bool created;
                using (var mutex = new Mutex(true, @"Local\FemDesktop-" + id, out created)) {
                    if (!created) {
                        // A duplicate can arrive while the first instance is still
                        // starting. Wait briefly for its activation event to exist.
                        for (int i = 0; i < 20; i++) {
                            try { using (var existing = EventWaitHandle.OpenExisting(@"Local\FemDesktop-Activate-" + id)) existing.Set(); return 0; }
                            catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(100); }
                        }
                        return 0;
                    }
                    using (var activate = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\FemDesktop-Activate-" + id))
                        Run(root, state, activate);
                }
                return 0;
            } catch (Exception error) {
                try { File.AppendAllText(System.IO.Path.Combine(state, "launcher.log"), DateTime.Now.ToString("s") + " " + error + Environment.NewLine, Encoding.UTF8); } catch { }
                MessageBox.Show("启动失败：" + error.Message + "\n\n请保留完整程序文件夹。日志位置：\n" + System.IO.Path.Combine(state, "launcher.log"),
                    "TENSORA", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        static void Run(string root, string state, EventWaitHandle activate) {
            string node = System.IO.Path.Combine(root, @"node-v24.21.0-win-x64\node.exe");
            string script = System.IO.Path.Combine(root, "server.js");
            if (!File.Exists(node) || !File.Exists(script)) throw new FileNotFoundException("未找到 Node.js 或 server.js。请将 EXE 放在完整程序目录内，不能单独移动 EXE。");
            var browser = SelectBrowser(FindBrowsers(), DefaultBrowserId());
            if (browser == null) throw new FileNotFoundException("未找到 Chrome 或 Microsoft Edge，请安装其中一个浏览器后重新打开。");
            int port; string portFile = System.IO.Path.Combine(state, "port.txt");
            if (!File.Exists(portFile) || !Int32.TryParse(File.ReadAllText(portFile).Trim(), out port) || port < 1024 || port > 65535) port = 5173;
            string logPath = System.IO.Path.Combine(state, "launcher.log");
            using (var log = new StreamWriter(logPath, false, Encoding.UTF8))
            using (var ready = new ManualResetEvent(false))
            using (var icons = new WindowIcons(System.IO.Path.Combine(root, "assets", "app.ico")))
            using (var job = new ProcessJob())
            using (var server = new Process()) {
                log.AutoFlush = true; object gate = new object();
                Action<string> write = line => { if (line != null) lock (gate) log.WriteLine(DateTime.Now.ToString("s") + " " + line); };
                string readyUrl = null; int readyPort = 0;
                server.StartInfo = new ProcessStartInfo(node, Quote(script)) {
                    WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                server.StartInfo.EnvironmentVariables["FEM_OPEN_BROWSER"] = "0";
                server.StartInfo.EnvironmentVariables["FEM_DESKTOP"] = "1";
                server.StartInfo.EnvironmentVariables["PORT"] = port.ToString();
                server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                    write(e.Data); string url; int actual;
                    if (TryReady(e.Data, server.Id, out url, out actual)) { readyUrl = url; readyPort = actual; ready.Set(); }
                };
                server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { write(e.Data); };
                try {
                    server.Start();
                    try { job.Add(server); } catch { server.Kill(); throw; }
                    server.BeginOutputReadLine(); server.BeginErrorReadLine();
                    var startup = Stopwatch.StartNew();
                    while (!ready.WaitOne(100)) {
                        if (server.HasExited) throw new InvalidOperationException("本地服务启动失败。请查看启动日志。");
                        if (startup.ElapsedMilliseconds > 30000) throw new TimeoutException("本地服务启动超时。");
                    }
                    File.WriteAllText(portFile, readyPort.ToString());
                    string profile = System.IO.Path.Combine(state, "Browser", browser.Name);
                    Directory.CreateDirectory(profile);
                    write("server=" + server.Id + " url=" + readyUrl + " browser=" + browser.Name);
                    using (var windowProcess = job.StartBrowser(browser.Path, BrowserArguments(readyUrl, profile), root)) {
                        write("browserPid=" + windowProcess.Id);
                        bool seenWindow = false, activationPending = true;
                        var sinceWindow = Stopwatch.StartNew();
                        startup.Restart();
                        while (true) {
                            if (server.HasExited) throw new InvalidOperationException("本地服务意外退出。请重新打开软件；详细信息已写入日志。");
                            var windows = job.Windows();
                            foreach (IntPtr window in windows) icons.Apply(window);
                            if (activate.WaitOne(200)) activationPending = true;
                            if (windows.Count > 0) {
                                seenWindow = true; sinceWindow.Restart();
                                if (activationPending) { ProcessJob.Activate(windows[0]); activationPending = false; }
                            } else if (seenWindow && sinceWindow.ElapsedMilliseconds > 1200) break;
                            else if (!seenWindow && startup.ElapsedMilliseconds > 30000)
                                throw new TimeoutException("浏览器窗口未能打开，请关闭后重试或检查浏览器安装。");
                        }
                    }
                } finally {
                    // Gracefully stop accepting requests; job disposal is the
                    // final guarantee for in-flight solvers and browser helpers.
                    try { if (!server.HasExited) { server.StandardInput.Close(); server.WaitForExit(2500); } }
                    catch (InvalidOperationException) { } catch (IOException) { }
                    job.Dispose();
                    try {
                        // The parameterless overload also drains asynchronous
                        // output callbacks before their log/event are disposed.
                        if (server.WaitForExit(3000)) server.WaitForExit();
                        server.CancelOutputRead(); server.CancelErrorRead();
                    } catch (InvalidOperationException) { }
                    write("Desktop session closed.");
                }
            }
        }
    }
}
