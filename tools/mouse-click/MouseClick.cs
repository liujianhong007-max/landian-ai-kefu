using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PddFuke.MouseClick
{
    internal static class Program
    {
        private const uint INPUT_MOUSE = 0;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;

        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            int clientX;
            int clientY;
            if (args.Length < 2 || !Int32.TryParse(args[0], out clientX) || !Int32.TryParse(args[1], out clientY))
            {
                Console.Error.WriteLine("Usage: MouseClick.exe <clientX> <clientY> [titleContains]");
                return 2;
            }

            var titleContains = args.Length >= 3 ? args[2] : "接待中心";
            var hwnd = FindVisibleWindow(titleContains);
            if (hwnd == IntPtr.Zero)
            {
                Console.Error.WriteLine("window not found: title contains \"{0}\"", titleContains);
                return 3;
            }

            var pt = new POINT { X = clientX, Y = clientY };
            if (!ClientToScreen(hwnd, ref pt))
            {
                Console.Error.WriteLine("ClientToScreen failed");
                return 4;
            }

            SetForegroundWindow(hwnd);
            Thread.Sleep(120);
            SetCursorPos(pt.X, pt.Y);
            Thread.Sleep(80);
            SendLeftClick();

            Console.WriteLine("clicked hwnd=0x{0:X} title=\"{1}\" client=({2},{3}) screen=({4},{5})",
                hwnd.ToInt64(),
                WindowText(hwnd),
                clientX,
                clientY,
                pt.X,
                pt.Y);
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

        private static void SendLeftClick()
        {
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
            inputs[1].type = INPUT_MOUSE;
            inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;

            var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                throw new InvalidOperationException("SendInput sent " + sent + " inputs");
            }
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
        private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public MOUSEINPUT mi;
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
