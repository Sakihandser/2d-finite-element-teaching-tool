using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace FemDesktop {
    // The handle is deliberately not inherited. Windows kills this installation's
    // complete process tree when the launcher exits, including an abrupt crash.
    public sealed class ProcessJob : IDisposable {
        IntPtr handle;
        public ProcessJob() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception();
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf(info))) {
                int code = Marshal.GetLastWin32Error(); Dispose(); throw new Win32Exception(code);
            }
        }
        public void Add(Process process) {
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new Win32Exception();
        }
        public Process StartBrowser(string executable, string arguments, string directory) {
            var startup = new StartupInfo(); startup.Size = Marshal.SizeOf(startup);
            ProcessInfo child;
            // Suspend before job assignment, so no Chromium children can escape
            // between creation and ownership (and no ordinary browser is attached).
            if (!CreateProcess(executable, new StringBuilder(Launcher.Quote(executable) + " " + arguments),
                IntPtr.Zero, IntPtr.Zero, false, 4, IntPtr.Zero, directory, ref startup, out child)) throw new Win32Exception();
            try {
                if (!AssignProcessToJobObject(handle, child.Process)) throw new Win32Exception();
                if (ResumeThread(child.Thread) == uint.MaxValue) throw new Win32Exception();
                return Process.GetProcessById((int)child.Id);
            } catch { TerminateProcess(child.Process, 1); throw; }
            finally { CloseHandle(child.Thread); CloseHandle(child.Process); }
        }
        public List<IntPtr> Windows() {
            var result = new List<IntPtr>();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint id; GetWindowThreadProcessId(window, out id);
                if (!IsWindowVisible(window)) return true;
                var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
                if (name.ToString() != "Chrome_WidgetWin_1") return true;
                IntPtr process = OpenProcess(0x1000, false, id);
                if (process == IntPtr.Zero) return true;
                bool owned;
                try { if (IsProcessInJob(process, handle, out owned) && owned) result.Add(window); }
                finally { CloseHandle(process); }
                return true;
            }, IntPtr.Zero);
            return result;
        }
        public static void Activate(IntPtr window) {
            if (IsIconic(window)) ShowWindow(window, 9);
            SetForegroundWindow(window);
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }

        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime; public uint LimitFlags;
            public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint Priority, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
            public ushort ShowWindow, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
        delegate bool EnumWindowCallback(IntPtr window, IntPtr unused);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback, IntPtr unused);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    }
}
