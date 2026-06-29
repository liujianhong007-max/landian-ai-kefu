using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace PddFuke.ProcessDiagnostics
{
    internal static class Program
    {
        private const uint PROCESS_QUERY_INFORMATION = 0x0400;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint TOKEN_QUERY = 0x0008;

        private static int Main(string[] args)
        {
            var names = args.Length == 0
                ? new[] { "fuke-helper.exe", "PddFukeHelper.exe", "PddFukeHelper-debug.exe", "PddFukeHelper-debug2.exe", "PddFukeHelper-debug3.exe", "PddFukeHelper-parity.exe", "AliWorkbench.exe", "AliRender.exe", "AlibabaProtect.exe", "electron.exe", "explorer.exe" }
                : args;

            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("time={0:yyyy-MM-dd HH:mm:ss.fff}", DateTime.Now);
            Console.WriteLine("current pid={0} user={1} admin={2} session={3}",
                Process.GetCurrentProcess().Id,
                WindowsIdentity.GetCurrent().Name,
                IsAdministrator(),
                Process.GetCurrentProcess().SessionId);
            Console.WriteLine();

            var rows = QueryProcesses(names);
            rows.Sort((a, b) =>
            {
                var nameCompare = String.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
                return nameCompare != 0 ? nameCompare : a.Pid.CompareTo(b.Pid);
            });

            foreach (var row in rows)
            {
                Print(row);
            }

            return 0;
        }

        private static List<ProcessRow> QueryProcesses(string[] names)
        {
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in names)
            {
                if (!String.IsNullOrWhiteSpace(name))
                {
                    wanted.Add(name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                        ? name.Substring(0, name.Length - 4)
                        : name);
                }
            }

            var rows = new List<ProcessRow>();
            foreach (var process in Process.GetProcesses())
            {
                try
                {
                    if (wanted.Count > 0 && !wanted.Contains(process.ProcessName)) continue;
                    var row = new ProcessRow
                    {
                        Pid = process.Id,
                        ParentPid = ReadParentPid(process.Id),
                        Name = process.ProcessName + ".exe",
                        ExecutablePath = Safe(() => process.MainModule.FileName),
                        CreationDate = Safe(() => process.StartTime.ToString("yyyy-MM-dd HH:mm:ss.fff")),
                        InterestingModules = ReadInterestingModules(process)
                    };
                    FillRuntimeInfo(row);
                    rows.Add(row);
                }
                catch
                {
                }
                finally
                {
                    process.Dispose();
                }
            }

            return rows;
        }

        private static void FillRuntimeInfo(ProcessRow row)
        {
            try
            {
                using (var process = Process.GetProcessById(row.Pid))
                {
                    row.SessionId = process.SessionId;
                    row.MainWindowTitle = Safe(() => process.MainWindowTitle);
                }
            }
            catch (Exception ex)
            {
                row.ProcessError = ex.GetType().Name + ": " + ex.Message;
            }

            IntPtr processHandle = IntPtr.Zero;
            IntPtr tokenHandle = IntPtr.Zero;
            try
            {
                processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, row.Pid);
                if (processHandle == IntPtr.Zero)
                {
                    processHandle = OpenProcess(PROCESS_QUERY_INFORMATION, false, row.Pid);
                }
                if (processHandle == IntPtr.Zero)
                {
                    row.TokenError = "OpenProcess failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                    return;
                }

                if (!OpenProcessToken(processHandle, TOKEN_QUERY, out tokenHandle))
                {
                    row.TokenError = "OpenProcessToken failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                    return;
                }

                row.TokenUser = SafeTokenUser(tokenHandle);
                row.TokenElevation = ReadElevation(tokenHandle);
                row.TokenElevationType = ReadElevationType(tokenHandle);
                row.TokenIntegrity = ReadIntegrity(tokenHandle);
                row.TokenSessionId = ReadTokenUInt(tokenHandle, TOKEN_INFORMATION_CLASS.TokenSessionId);
                row.TokenAuthId = ReadTokenAuthId(tokenHandle);
            }
            catch (Exception ex)
            {
                row.TokenError = ex.GetType().Name + ": " + ex.Message;
            }
            finally
            {
                if (tokenHandle != IntPtr.Zero) CloseHandle(tokenHandle);
                if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
            }
        }

        private static void Print(ProcessRow row)
        {
            Console.WriteLine("[{0}] pid={1} ppid={2} session={3} tokenSession={4}", row.Name, row.Pid, row.ParentPid, Value(row.SessionId), Value(row.TokenSessionId));
            Console.WriteLine("  user={0} elevated={1} elevationType={2} integrity={3} authId={4}",
                Empty(row.TokenUser),
                Empty(row.TokenElevation),
                Empty(row.TokenElevationType),
                Empty(row.TokenIntegrity),
                Empty(row.TokenAuthId));
            Console.WriteLine("  exe={0}", Empty(row.ExecutablePath));
            Console.WriteLine("  created={0}", Empty(row.CreationDate));
            Console.WriteLine("  title={0}", Empty(row.MainWindowTitle));
            Console.WriteLine("  modules={0}", row.InterestingModules.Count == 0 ? "(empty)" : String.Join(" | ", row.InterestingModules));
            if (!String.IsNullOrWhiteSpace(row.ProcessError)) Console.WriteLine("  processError={0}", row.ProcessError);
            if (!String.IsNullOrWhiteSpace(row.TokenError)) Console.WriteLine("  tokenError={0}", row.TokenError);
            Console.WriteLine();
        }

        private static List<string> ReadInterestingModules(Process process)
        {
            var modules = new List<string>();
            try
            {
                foreach (ProcessModule module in process.Modules)
                {
                    var name = module.ModuleName ?? "";
                    var path = module.FileName ?? "";
                    if (!IsInterestingModule(name, path)) continue;
                    modules.Add(name + "@" + path);
                }
            }
            catch (Exception ex)
            {
                modules.Add("error:" + ex.GetType().Name + ":" + ex.Message);
            }

            modules.Sort(StringComparer.OrdinalIgnoreCase);
            return modules;
        }

        private static bool IsInterestingModule(string name, string path)
        {
            return name.IndexOf("QnExtend", StringComparison.OrdinalIgnoreCase) >= 0
                || name.IndexOf("PddExtend", StringComparison.OrdinalIgnoreCase) >= 0
                || path.IndexOf("\\assets\\inject\\", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool IsAdministrator()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        private static string Safe(Func<string> read)
        {
            try { return read() ?? ""; }
            catch { return ""; }
        }

        private static string SafeTokenUser(IntPtr token)
        {
            try
            {
                using (var identity = new WindowsIdentity(token))
                {
                    return identity.Name;
                }
            }
            catch (Exception ex)
            {
                return "error: " + ex.Message;
            }
        }

        private static string ReadElevation(IntPtr token)
        {
            var value = ReadTokenUInt(token, TOKEN_INFORMATION_CLASS.TokenElevation);
            if (!value.HasValue) return "";
            return value.Value == 0 ? "false" : "true";
        }

        private static string ReadElevationType(IntPtr token)
        {
            var value = ReadTokenUInt(token, TOKEN_INFORMATION_CLASS.TokenElevationType);
            if (!value.HasValue) return "";
            switch (value.Value)
            {
                case 1: return "Default";
                case 2: return "Full";
                case 3: return "Limited";
                default: return value.Value.ToString();
            }
        }

        private static string ReadTokenAuthId(IntPtr token)
        {
            var size = 0;
            GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenStatistics, IntPtr.Zero, 0, out size);
            if (size <= 0) return "";

            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                if (!GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenStatistics, ptr, size, out size)) return "";
                var stats = (TOKEN_STATISTICS)Marshal.PtrToStructure(ptr, typeof(TOKEN_STATISTICS));
                return stats.AuthenticationId.HighPart.ToString("x8") + ":" + stats.AuthenticationId.LowPart.ToString("x8");
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        private static uint? ReadTokenUInt(IntPtr token, TOKEN_INFORMATION_CLASS tokenClass)
        {
            var size = 0;
            GetTokenInformation(token, tokenClass, IntPtr.Zero, 0, out size);
            if (size <= 0) return null;

            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                if (!GetTokenInformation(token, tokenClass, ptr, size, out size)) return null;
                return (uint)Marshal.ReadInt32(ptr);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        private static string ReadIntegrity(IntPtr token)
        {
            var size = 0;
            GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenIntegrityLevel, IntPtr.Zero, 0, out size);
            if (size <= 0) return "";

            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                if (!GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenIntegrityLevel, ptr, size, out size))
                {
                    return "";
                }

                var sid = Marshal.ReadIntPtr(ptr);
                var countPtr = GetSidSubAuthorityCount(sid);
                var count = Marshal.ReadByte(countPtr);
                var ridPtr = GetSidSubAuthority(sid, count - 1);
                var rid = (uint)Marshal.ReadInt32(ridPtr);
                return IntegrityName(rid) + " (" + rid + ")";
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        private static string IntegrityName(uint rid)
        {
            if (rid >= 0x4000) return "System";
            if (rid >= 0x3000) return "High";
            if (rid >= 0x2000) return "Medium";
            if (rid >= 0x1000) return "Low";
            return "Untrusted";
        }

        private static string Empty(string value)
        {
            return String.IsNullOrEmpty(value) ? "(empty)" : value;
        }

        private static string Value(int? value)
        {
            return value.HasValue ? value.Value.ToString() : "(unknown)";
        }

        private static string Value(uint? value)
        {
            return value.HasValue ? value.Value.ToString() : "(unknown)";
        }

        private static int ReadParentPid(int pid)
        {
            IntPtr processHandle = IntPtr.Zero;
            try
            {
                processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (processHandle == IntPtr.Zero)
                {
                    processHandle = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid);
                }
                if (processHandle == IntPtr.Zero) return 0;

                var info = new PROCESS_BASIC_INFORMATION();
                int returnLength;
                var status = NtQueryInformationProcess(
                    processHandle,
                    0,
                    ref info,
                    Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
                    out returnLength);
                if (status != 0) return 0;
                return info.InheritedFromUniqueProcessId.ToInt32();
            }
            catch
            {
                return 0;
            }
            finally
            {
                if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr TokenHandle, TOKEN_INFORMATION_CLASS TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern IntPtr GetSidSubAuthority(IntPtr pSid, int nSubAuthority);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr pSid);

        private enum TOKEN_INFORMATION_CLASS
        {
            TokenUser = 1,
            TokenStatistics = 10,
            TokenElevation = 20,
            TokenElevationType = 18,
            TokenIntegrityLevel = 25,
            TokenSessionId = 12
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_STATISTICS
        {
            public LUID TokenId;
            public LUID AuthenticationId;
            public long ExpirationTime;
            public uint TokenType;
            public uint ImpersonationLevel;
            public uint DynamicCharged;
            public uint DynamicAvailable;
            public uint GroupCount;
            public uint PrivilegeCount;
            public LUID ModifiedId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        private sealed class ProcessRow
        {
            public int Pid;
            public int ParentPid;
            public string Name;
            public string ExecutablePath;
            public string CreationDate;
            public int? SessionId;
            public uint? TokenSessionId;
            public string TokenUser;
            public string TokenElevation;
            public string TokenElevationType;
            public string TokenIntegrity;
            public string TokenAuthId;
            public string MainWindowTitle;
            public List<string> InterestingModules = new List<string>();
            public string ProcessError;
            public string TokenError;
        }
    }
}
