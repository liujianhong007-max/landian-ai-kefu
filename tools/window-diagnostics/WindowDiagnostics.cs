using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace PddFuke.WindowDiagnostics
{
    internal static class Program
    {
        private const uint GA_ROOT = 2;

        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            var watch = HasArg(args, "watch");
            var includeUia = HasArg(args, "uia");
            do
            {
                PrintSnapshot(includeUia);
                if (!watch) break;
                Console.WriteLine("----");
                Thread.Sleep(1000);
            } while (true);
            return 0;
        }

        private static bool HasArg(string[] args, string value)
        {
            foreach (var arg in args)
            {
                if (String.Equals(arg, value, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static void PrintSnapshot(bool includeUia)
        {
            POINT pt;
            GetCursorPos(out pt);
            var hwnd = WindowFromPoint(pt);
            var root = hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, GA_ROOT);

            Console.WriteLine("time={0:yyyy-MM-dd HH:mm:ss.fff}", DateTime.Now);
            Console.WriteLine("cursor screen=({0},{1})", pt.X, pt.Y);
            PrintWindow("point-window", hwnd, pt);
            PrintWindow("root-window", root, pt);
            PrintParentChain(hwnd, pt);
            PrintAliWindows();
            if (includeUia) PrintUia(pt);
            else Console.WriteLine("uia: skipped");
        }

        private static void PrintWindow(string label, IntPtr hwnd, POINT pt)
        {
            if (hwnd == IntPtr.Zero)
            {
                Console.WriteLine("{0}: (none)", label);
                return;
            }

            RECT rect;
            GetWindowRect(hwnd, out rect);
            uint pid;
            var tid = GetWindowThreadProcessId(hwnd, out pid);
            var client = pt;
            ScreenToClient(hwnd, ref client);
            Console.WriteLine("{0}: hwnd=0x{1:X} pid={2} tid={3} proc={4} class=\"{5}\" title=\"{6}\" rect=({7},{8},{9},{10}) client=({11},{12})",
                label,
                hwnd.ToInt64(),
                pid,
                tid,
                ProcessName(pid),
                ClassName(hwnd),
                WindowText(hwnd),
                rect.Left,
                rect.Top,
                rect.Right,
                rect.Bottom,
                client.X,
                client.Y);
        }

        private static void PrintParentChain(IntPtr hwnd, POINT pt)
        {
            Console.WriteLine("parent-chain:");
            var seen = new HashSet<IntPtr>();
            var current = hwnd;
            var index = 0;
            while (current != IntPtr.Zero && seen.Add(current) && index < 12)
            {
                PrintWindow("  [" + index + "]", current, pt);
                current = GetParent(current);
                index++;
            }
        }

        private static void PrintAliWindows()
        {
            Console.WriteLine("ali top windows:");
            EnumWindows((hwnd, lparam) =>
            {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                var proc = ProcessName(pid);
                if (!String.Equals(proc, "AliWorkbench", StringComparison.OrdinalIgnoreCase)
                    && !String.Equals(proc, "AliRender", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                RECT rect;
                GetWindowRect(hwnd, out rect);
                Console.WriteLine("  hwnd=0x{0:X} pid={1} proc={2} visible={3} class=\"{4}\" title=\"{5}\" rect=({6},{7},{8},{9})",
                    hwnd.ToInt64(),
                    pid,
                    proc,
                    IsWindowVisible(hwnd),
                    ClassName(hwnd),
                    WindowText(hwnd),
                    rect.Left,
                    rect.Top,
                    rect.Right,
                    rect.Bottom);
                return true;
            }, IntPtr.Zero);
        }

        private static void PrintUia(POINT pt)
        {
            Console.WriteLine("uia:");
            try
            {
                var element = AutomationElement.FromPoint(new System.Windows.Point(pt.X, pt.Y));
                if (element == null)
                {
                    Console.WriteLine("  element=(none)");
                    return;
                }
                PrintUiaElement("  point", element);
                var current = TreeWalker.ControlViewWalker.GetParent(element);
                var index = 0;
                while (current != null && index < 8)
                {
                    PrintUiaElement("  parent[" + index + "]", current);
                    current = TreeWalker.ControlViewWalker.GetParent(current);
                    index++;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("  error={0}: {1}", ex.GetType().Name, ex.Message);
            }
        }

        private static void PrintUiaElement(string label, AutomationElement element)
        {
            try
            {
                var p = element.Current;
                var rect = p.BoundingRectangle;
                Console.WriteLine("{0}: name=\"{1}\" automationId=\"{2}\" class=\"{3}\" type=\"{4}\" pid={5} rect=({6:0},{7:0},{8:0},{9:0})",
                    label,
                    p.Name,
                    p.AutomationId,
                    p.ClassName,
                    p.ControlType.ProgrammaticName,
                    p.ProcessId,
                    rect.Left,
                    rect.Top,
                    rect.Right,
                    rect.Bottom);
            }
            catch (Exception ex)
            {
                Console.WriteLine("{0}: error={1}: {2}", label, ex.GetType().Name, ex.Message);
            }
        }

        private static string ProcessName(uint pid)
        {
            try { return Process.GetProcessById((int)pid).ProcessName; }
            catch { return ""; }
        }

        private static string ClassName(IntPtr hwnd)
        {
            var sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
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
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetParent(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        private static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
    }
}
