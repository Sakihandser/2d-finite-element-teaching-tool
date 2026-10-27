using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Windows.Forms;
using FemDesktop;

public static class LauncherTests {
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr kind, IntPtr value);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    static int assertions;
    static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
    public static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "--child") { Thread.Sleep(60000); return 0; }
        if (args.Length > 0 && args[0] == "--parent") {
            using (var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--child") { UseShellExecute = false, CreateNoWindow = true })) {
                File.WriteAllText(args[1], child.Id.ToString()); Thread.Sleep(60000);
            }
            return 0;
        }
        if (args.Length > 0 && args[0] == "--argv") { File.WriteAllLines(args[1], new List<string>(args).GetRange(2, args.Length - 2).ToArray(), Encoding.UTF8); return 0; }
        string scratch = Path.Combine(Path.GetTempPath(), "fem-launcher-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        var processes = new List<Process>();
        try {
            var image = File.ReadAllBytes(typeof(Launcher).Assembly.Location);
            int peHeader = BitConverter.ToInt32(image, 0x3c);
            Check(BitConverter.ToUInt16(image, peHeader + 24 + 68) == 2, "Windows GUI subsystem: no launcher console");
            Check(WindowIcons.PixelSize(96, true) == 32 && WindowIcons.PixelSize(144, true) == 48 && WindowIcons.PixelSize(192, true) == 64, "Taskbar icon follows DPI");
            Check(WindowIcons.PixelSize(144, false) == 24, "Caption icon follows DPI");
            using (var icons = new WindowIcons(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Tensora.ico")))
            using (var form = new Form()) {
                IntPtr window = form.Handle;
                icons.Apply(window);
                for (int kind = 0; kind <= 1; kind++) {
                    IntPtr icon = SendMessage(window, 0x7f, new IntPtr(kind), IntPtr.Zero);
                    using (var bitmap = Icon.FromHandle(icon).ToBitmap())
                        Check(bitmap.Width == WindowIcons.PixelSize(GetDpiForWindow(window), kind == 1), "Native icon has requested pixels");
                    icons.Apply(window);
                    Check(SendMessage(window, 0x7f, new IntPtr(kind), IntPtr.Zero) == icon, "Unchanged icon reuses handle");
                }
                IntPtr expected = SendMessage(window, 0x7f, new IntPtr(1), IntPtr.Zero);
                SendMessage(window, 0x80, new IntPtr(1), SystemIcons.Application.Handle);
                icons.Apply(window);
                Check(SendMessage(window, 0x7f, new IntPtr(1), IntPtr.Zero) == expected, "Restore native icon after browser replacement");
                icons.Apply(IntPtr.Zero); // Closed window is harmless.
            }
            var browsers = new List<BrowserSpec> { new BrowserSpec("Chrome", "chrome"), new BrowserSpec("Edge", "edge") };
            Check(Launcher.SelectBrowser(browsers, "MSEdgeHTM").Name == "Edge", "Respect default Edge");
            Check(Launcher.SelectBrowser(browsers, "ChromeHTML").Name == "Chrome", "Respect default Chrome");
            Check(Launcher.SelectBrowser(browsers, "FirefoxURL").Name == "Chrome", "Compatible fallback");
            Check(Launcher.SelectBrowser(new List<BrowserSpec>{ browsers[1] }, "ChromeHTML").Name == "Edge", "Only installed compatible browser");
            Check(Launcher.SelectBrowser(new List<BrowserSpec>(), "") == null, "No browser");
            Check(Launcher.InstallationId(@"C:\测试 path\app\") == Launcher.InstallationId(@"c:\测试 path\APP"), "Stable install identity");
            Check(Launcher.InstallationId(@"C:\app1") != Launcher.InstallationId(@"C:\app2"), "Separate installation identity");
            string arguments = Launcher.BrowserArguments("http://127.0.0.1:5174/", @"C:\测试 space\profile");
            Check(arguments.Contains("--app=http://127.0.0.1:5174/"), "Application window");
            Check(arguments.Contains(@"--user-data-dir=C:\测试 space\profile"), "Isolated browser profile");
            Check(arguments.Contains("--disable-background-mode"), "No browser background persistence");
            foreach (string url in new[] { "https://example.com/", "http://localhost:5173/", "http://127.0.0.1:5173/file", "http://127.0.0.1:5173/?a=1", "http://x@127.0.0.1:5173/" }) {
                bool rejected = false; try { Launcher.BrowserArguments(url, "profile"); } catch (ArgumentException) { rejected = true; }
                Check(rejected, "Reject non-launcher URL: " + url);
            }
            string ready; int port;
            Check(Launcher.TryReady("FEM_DESKTOP_READY {\"pid\":123,\"port\":5174,\"url\":\"http://127.0.0.1:5174/\"}", 123, out ready, out port) && port == 5174, "Read actual bound port");
            Check(!Launcher.TryReady("FEM_DESKTOP_READY {\"pid\":321,\"port\":5174,\"url\":\"http://127.0.0.1:5174/\"}", 123, out ready, out port), "Reject wrong server identity");
            Check(!Launcher.TryReady("FEM_DESKTOP_READY {\"pid\":123,\"port\":5174,\"url\":\"http://example.com/\"}", 123, out ready, out port), "Reject mismatched readiness URL");
            Check(!Launcher.TryReady("FEM_DESKTOP_READY broken", 123, out ready, out port), "Reject malformed readiness");

            // Round-trip Windows argument parsing through an actual process.
            string argvFile = Path.Combine(scratch, "argv.txt");
            string[] values = { "", "normal", "space 测试", "quote\"inside", @"C:\trailing space\", "two\\\\\"quotes" };
            var command = new StringBuilder("--argv " + Launcher.Quote(argvFile));
            foreach (string value in values) command.Append(" ").Append(Launcher.Quote(value));
            using (var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, command.ToString()) { UseShellExecute = false, CreateNoWindow = true })) {
                Check(child.WaitForExit(5000) && child.ExitCode == 0, "Argument subprocess");
            }
            string[] actual = File.ReadAllLines(argvFile, Encoding.UTF8);
            Check(actual.Length == values.Length, "Argument count");
            for (int i = 0; i < values.Length; i++) Check(actual[i] == values[i], "Argument round-trip " + i);

            // Real Windows job: both the launched parent and its descendant
            // must die when the owning handle is closed; an unrelated process lives.
            string pidFile = Path.Combine(scratch, "grandchild.txt");
            var unrelated = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--child") { UseShellExecute = false, CreateNoWindow = true });
            processes.Add(unrelated);
            using (var job = new ProcessJob()) {
                var parent = job.StartBrowser(Process.GetCurrentProcess().MainModule.FileName, "--parent " + Launcher.Quote(pidFile), scratch);
                processes.Add(parent);
                var timer = Stopwatch.StartNew();
                while (!File.Exists(pidFile) && timer.ElapsedMilliseconds < 5000) Thread.Sleep(30);
                Check(File.Exists(pidFile), "Child process started");
                var grandchild = Process.GetProcessById(Int32.Parse(File.ReadAllText(pidFile))); processes.Add(grandchild);
                job.Dispose();
                Check(parent.WaitForExit(5000), "Job kills parent");
                Check(grandchild.WaitForExit(5000), "Job kills solver descendant");
                Check(!unrelated.HasExited, "Unrelated browser/server is preserved");
            }
            Console.WriteLine("Launcher checks passed: " + assertions);
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally {
            foreach (var process in processes) { try { if (!process.HasExited) process.Kill(); process.WaitForExit(3000); } catch (InvalidOperationException) { } process.Dispose(); }
            // Only delete the unique, verified temporary directory created above.
            if (Path.GetFullPath(scratch).StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) Directory.Delete(scratch, true);
        }
    }
}
