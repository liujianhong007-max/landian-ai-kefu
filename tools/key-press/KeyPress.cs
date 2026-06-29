using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PddFuke.KeyPress
{
    internal static class Program
    {
        private const uint INPUT_KEYBOARD = 1;
        private const ushort VK_RETURN = 0x0D;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            var titleContains = args.Length >= 1 ? args[0] : "接待中心";
            var hwnd = FindVisibleWindow(titleContains);
            if (hwnd == IntPtr.Zero)
            {
                Console.Error.WriteLine("window not found: title contains \"{0}\"", titleContains);
                return 3;
            }

            SetForegroundWindow(hwnd);
            Thread.Sleep(120);
            if (!SendEnter())
            {
                return 4;
            }
            Console.WriteLine("pressed Enter hwnd=0x{0:X} title=\"{1}\"", hwnd.ToInt64(), WindowText(hwnd));
            return 0;
        }

        private static IntPtr FindVisibleWindow(string titleContains)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows((hwnd, lparam) =>
            {
                if (!IsWindowVisible(hwnd)) return true;
                var title = WindowText(hwnd);
                if (title.IndexOf(titleContains, StringComparison.OrdinalIgnoreCase) < 0) return true;
                found = hwnd;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        private static bool SendEnter()
        {
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = VK_RETURN;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki.wVk = VK_RETURN;
            inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;

            var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                Console.Error.WriteLine("SendInput sent {0}/{1}, error={2}", sent, inputs.Length, Marshal.GetLastWin32Error());
                return false;
            }
            return true;
        }

        private static string WindowText(IntPtr hwnd)
        {
            var length = GetWindowTextLength(hwnd);
            var sb = new StringBuilder(Math.Max(length + 1, 256));
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)]
            public KEYBDINPUT ki;

            [FieldOffset(0)]
            public MOUSEINPUT mi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
    }
}
