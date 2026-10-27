using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FemDesktop {
    // Chromium's app-mode favicon can be upscaled from 16px. Load the native
    // frame at the window's DPI instead, and restore it after favicon refreshes.
    public sealed class WindowIcons : IDisposable {
        readonly string path;
        readonly Dictionary<int, IntPtr> images = new Dictionary<int, IntPtr>();
        public WindowIcons(string path) { this.path = path; }
        public static int PixelSize(uint dpi, bool large) {
            return Math.Max(1, (int)(((large ? 32 : 16) * dpi + 48) / 96));
        }
        IntPtr Image(int size) {
            IntPtr image;
            if (!images.TryGetValue(size, out image)) {
                image = LoadImage(IntPtr.Zero, path, 1, size, size, 0x10);
                if (image == IntPtr.Zero) throw new Win32Exception();
                images.Add(size, image);
            }
            return image;
        }
        static bool Message(IntPtr window, uint message, int kind, IntPtr value, out UIntPtr result) {
            return SendMessageTimeout(window, message, new UIntPtr((uint)kind), value,
                2, 100, out result) != IntPtr.Zero;
        }
        public void Apply(IntPtr window) {
            uint dpi = GetDpiForWindow(window);
            if (dpi == 0) return; // Window closed between enumeration and update.
            for (int kind = 0; kind <= 1; kind++) {
                IntPtr expected = Image(PixelSize(dpi, kind == 1));
                UIntPtr current;
                if (Message(window, 0x7f, kind, IntPtr.Zero, out current) && current.ToUInt64() != (ulong)expected.ToInt64())
                    Message(window, 0x80, kind, expected, out current);
            }
        }
        public void Dispose() {
            foreach (IntPtr image in images.Values) DestroyIcon(image);
            images.Clear();
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
        static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
            uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    }
}
