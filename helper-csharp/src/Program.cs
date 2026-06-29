using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace PddFukeHelper
{
    internal static class Program
    {
        private const string Version = "pdd-fuke-helper-csharp";
        private const string ExitAfterLaunchArg = "--exit-after-launch";
        private const string NoTokenStealArg = "--no-token-steal";
        private static bool _noTokenSteal;

        private static int Main(string[] args)
        {
            _noTokenSteal = HasArg(args, NoTokenStealArg)
                || String.Equals(Environment.GetEnvironmentVariable("PDD_FUKE_HELPER_NO_TOKEN_STEAL"), "1", StringComparison.Ordinal);
            HelperLog.Write("Main=> started. exe={0}, args={1}, isAdmin={2}, identity={3}, session={4}, noTokenSteal={5}",
                Process.GetCurrentProcess().MainModule.FileName,
                JoinArguments(args),
                IsAdministrator(),
                WindowsIdentity.GetCurrent().Name,
                Process.GetCurrentProcess().SessionId,
                _noTokenSteal);
            NativeLauncher.EnableLaunchPrivileges();

            if (args.Length < 1)
            {
                Console.Error.WriteLine("Usage: PddFukeHelper.exe ws://127.0.0.1:5555/Extend");
                HelperLog.Write("Main=> missing websocket url.");
                return 2;
            }

            try
            {
                if (ShouldSelfElevate())
                {
                    HelperLog.Write("Main=> self elevating.");
                    return RestartElevated(args);
                }

                new HelperRuntime(args[0], ShouldExitAfterLaunch(args)).RunAsync().GetAwaiter().GetResult();
                HelperLog.Write("Main=> websocket disconnected, terminating process.");
                return 0;
            }
            catch (Exception ex)
            {
                HelperLog.Write("Main=> fatal: {0}", ex);
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        private static bool ShouldSelfElevate()
        {
            if (!String.Equals(Environment.GetEnvironmentVariable("PDD_FUKE_HELPER_ELEVATE"), "1", StringComparison.Ordinal)) return false;
            return !IsAdministrator();
        }

        private static bool IsAdministrator()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        private static int RestartElevated(string[] args)
        {
            var exePath = Process.GetCurrentProcess().MainModule.FileName;
            var elevatedArgs = AppendElevatedArgs(args);
            var psi = new ProcessStartInfo(exePath)
            {
                UseShellExecute = true,
                Verb = "runas",
                Arguments = JoinArguments(elevatedArgs)
            };

            Process.Start(psi);
            HelperLog.Write("RestartElevated=> launched elevated helper.");
            return 0;
        }

        private static string[] AppendElevatedArgs(string[] args)
        {
            var result = new List<string>(args);
            if (ShouldExitAfterLaunch(args) && !HasArg(result, ExitAfterLaunchArg))
                result.Add(ExitAfterLaunchArg);
            if (_noTokenSteal && !HasArg(result, NoTokenStealArg))
                result.Add(NoTokenStealArg);
            return result.ToArray();
        }

        private static string[] AppendExitAfterLaunchArg(string[] args)
        {
            if (!ShouldExitAfterLaunch(args)) return args;
            if (HasArg(args, ExitAfterLaunchArg)) return args;

            var elevatedArgs = new List<string>(args);
            elevatedArgs.Add(ExitAfterLaunchArg);
            return elevatedArgs.ToArray();
        }

        private static bool ShouldExitAfterLaunch(string[] args)
        {
            return HasArg(args, ExitAfterLaunchArg)
                || String.Equals(Environment.GetEnvironmentVariable("PDD_FUKE_HELPER_EXIT_AFTER_LAUNCH"), "1", StringComparison.Ordinal);
        }

        private static bool HasArg(ICollection<string> args, string value)
        {
            foreach (var arg in args)
            {
                if (String.Equals(arg, value, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        private static bool HasArg(string[] args, string value)
        {
            return HasArg((ICollection<string>)args, value);
        }

        private static string JoinArguments(string[] args)
        {
            var parts = new List<string>();
            foreach (var arg in args) parts.Add(QuoteArgument(arg));
            return String.Join(" ", parts.ToArray());
        }

        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private sealed class HelperRuntime
        {
            private readonly Uri _uri;
            private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
            private readonly bool _exitAfterLaunch;

            public HelperRuntime(string wsUrl, bool exitAfterLaunch)
            {
                _uri = new Uri(wsUrl);
                _exitAfterLaunch = exitAfterLaunch;
            }

            public async System.Threading.Tasks.Task RunAsync()
            {
                using (var socket = new ClientWebSocket())
                {
                    HelperLog.Write("websocket=> connecting {0}", _uri);
                    await socket.ConnectAsync(_uri, CancellationToken.None);
                    HelperLog.Write("websocket=> connected.");
                    await SendAsync(socket, new Dictionary<string, object>
                    {
                        { "type", "event" },
                        { "body", new Dictionary<string, object>
                            {
                                { "name", "hello" },
                                { "param", new Dictionary<string, object>
                                    {
                                        { "platform", "fuke-helper" },
                                        { "version", Version }
                                    }
                                }
                            }
                        }
                    });

                    while (socket.State == WebSocketState.Open)
                    {
                        var raw = await ReceiveTextAsync(socket);
                        if (raw == null) break;
                        HelperLog.Write("websocket=> received: {0}", raw);
                        await HandleFrameAsync(socket, raw);
                    }
                }
            }

            private async System.Threading.Tasks.Task HandleFrameAsync(ClientWebSocket socket, string raw)
            {
                Dictionary<string, object> frame;
                string parseError = null;
                try
                {
                    frame = _json.DeserializeObject(raw) as Dictionary<string, object>;
                }
                catch (Exception ex)
                {
                    frame = null;
                    parseError = ex.Message;
                }

                if (parseError != null)
                {
                    await SendErrorAsync(socket, null, parseError);
                    return;
                }

                if (frame == null || !String.Equals(GetString(frame, "type"), "invoke", StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }

                var id = GetString(frame, "id");
                var body = GetDictionary(frame, "body");
                var name = GetString(body, "name");
                var param = GetDictionary(body, "param");

                object data = null;
                string errorMessage = null;
                try
                {
                    if (name == "execute_shell")
                    {
                        data = ExecuteShell(GetString(param, "command"));
                    }
                    else if (name == "launch_platform")
                    {
                        data = LaunchPlatform(param);
                    }
                    else
                    {
                        throw new InvalidOperationException("Unsupported helper invoke: " + name);
                    }

                }
                catch (Exception ex)
                {
                    errorMessage = ex.Message;
                }

                if (errorMessage != null)
                {
                    HelperLog.Write("websocket=> response error id={0}, message={1}", id, errorMessage);
                    await SendErrorAsync(socket, id, errorMessage);
                    return;
                }

                HelperLog.Write("websocket=> response ok id={0}, data={1}", id, _json.Serialize(data));
                await SendAsync(socket, new Dictionary<string, object>
                {
                    { "type", "response" },
                    { "id", id },
                    { "body", new Dictionary<string, object>
                        {
                            { "data", data },
                            { "message", "" },
                            { "success", true }
                        }
                    }
                });

                if (_exitAfterLaunch && name == "launch_platform")
                {
                    HelperLog.Write("websocket=> exit after launch_platform response.");
                    try
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "launch complete", CancellationToken.None);
                    }
                    catch
                    {
                    }
                    Environment.Exit(0);
                }
            }

            private async System.Threading.Tasks.Task SendErrorAsync(ClientWebSocket socket, string id, string message)
            {
                await SendAsync(socket, new Dictionary<string, object>
                {
                    { "type", "response" },
                    { "id", id },
                    { "body", new Dictionary<string, object>
                        {
                            { "data", null },
                            { "message", message },
                            { "success", false }
                        }
                    }
                });
            }

            private async System.Threading.Tasks.Task SendAsync(ClientWebSocket socket, object payload)
            {
                var bytes = Encoding.UTF8.GetBytes(_json.Serialize(payload));
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }

            private static async System.Threading.Tasks.Task<string> ReceiveTextAsync(ClientWebSocket socket)
            {
                var buffer = new byte[8192];
                using (var stream = new MemoryStream())
                {
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                        if (result.MessageType == WebSocketMessageType.Close) return null;
                        stream.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    return Encoding.UTF8.GetString(stream.ToArray());
                }
            }
        }

        private static Dictionary<string, object> ExecuteShell(string command)
        {
            if (String.IsNullOrWhiteSpace(command)) throw new ArgumentException("command is required");
            HelperLog.Write("ExecuteShell=> {0}", command);

            var psi = new ProcessStartInfo("cmd.exe", "/c " + command)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            using (var process = Process.Start(psi))
            {
                var output = process.StandardOutput.ReadToEnd();
                var error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                HelperLog.Write("ExecuteShell=> exitCode={0}, output={1}, stderr={2}", process.ExitCode, output, error);
                return new Dictionary<string, object>
                {
                    { "output", output },
                    { "stderr", error },
                    { "exitCode", process.ExitCode }
                };
            }
        }

        private static Dictionary<string, object> LaunchPlatform(Dictionary<string, object> param)
        {
            var exePath = GetString(param, "exe_path");
            var exeParam = GetString(param, "exe_param");
            var dllPath = GetString(param, "inject_dllpath");
            var userPower = Truthy(param, "user_power");
            var useDevtool = Truthy(param, "use_devtool");
            HelperLog.Write("LaunchPlatform=> exe_path={0}, exe_param={1}, user_power={2}, use_devtool={3}, inject_dllpath={4}, js_url={5}, js_data={6}, ws_url={7}",
                exePath,
                exeParam,
                userPower,
                useDevtool,
                dllPath,
                GetString(param, "js_url"),
                GetString(param, "js_data"),
                GetString(param, "ws_url"));

            if (String.IsNullOrWhiteSpace(exePath)) throw new ArgumentException("exe_path is required");
            if (!File.Exists(exePath)) throw new FileNotFoundException("exe_path not found", exePath);
            if (String.IsNullOrWhiteSpace(dllPath)) throw new ArgumentException("inject_dllpath is required");
            if (!File.Exists(dllPath)) throw new FileNotFoundException("inject_dllpath not found", dllPath);

            var env = BuildEnvironment(param);
            HelperLog.Write("LaunchPlatform=> env USERPROFILE={0}, LOCALAPPDATA={1}, APPDATA={2}, TEMP={3}, JS_URL={4}, JS_DATA={5}, USE_DEVTOOL={6}",
                GetEnvValue(env, "USERPROFILE"),
                GetEnvValue(env, "LOCALAPPDATA"),
                GetEnvValue(env, "APPDATA"),
                GetEnvValue(env, "TEMP"),
                GetEnvValue(env, "JS_URL"),
                GetEnvValue(env, "JS_DATA"),
                GetEnvValue(env, "USE_DEVTOOL"));
            var created = NativeLauncher.CreateSuspended(exePath, exeParam, env, userPower);
            var resumed = false;
            try
            {
                HelperLog.Write("LaunchPlatform=> created suspended pid={0}. injecting dll.", created.ProcessId);
                NativeLauncher.InjectDll(created.ProcessId, created.ThreadHandle, dllPath, GetString(param, "inject_mode"));
                HelperLog.Write("LaunchPlatform=> injected dll pid={0}. resuming main thread.", created.ProcessId);
                NativeMethods.ResumeThread(created.ThreadHandle);
                resumed = true;
                HelperLog.Write("LaunchPlatform=> success pid={0}", created.ProcessId);
                return new Dictionary<string, object> { { "pid", created.ProcessId } };
            }
            catch
            {
                HelperLog.Write("LaunchPlatform=> failed pid={0}, resumed={1}", created.ProcessId, resumed);
                if (!resumed) NativeMethods.TerminateProcess(created.ProcessHandle, 1);
                throw;
            }
            finally
            {
                NativeMethods.CloseHandle(created.ThreadHandle);
                NativeMethods.CloseHandle(created.ProcessHandle);
            }
        }

        private static Dictionary<string, string> BuildEnvironment(Dictionary<string, object> param)
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                env[Convert.ToString(entry.Key)] = Convert.ToString(entry.Value);
            }
            env["JS_URL"] = GetString(param, "js_url");
            env["JS_DATA"] = GetString(param, "js_data");
            env["WS_URL"] = GetString(param, "ws_url");
            env["USE_DEVTOOL"] = Truthy(param, "use_devtool") ? "1" : "0";
            return env;
        }

        private static string GetEnvValue(Dictionary<string, string> env, string key)
        {
            return env.ContainsKey(key) ? env[key] : "";
        }

        private static bool Truthy(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return false;
            var value = dict[key];
            if (value is bool) return (bool)value;
            if (value is int) return (int)value != 0;
            return GetString(dict, key) == "1" || String.Equals(GetString(dict, key), "true", StringComparison.OrdinalIgnoreCase);
        }

        private static string GetString(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return "";
            return Convert.ToString(dict[key]);
        }

        private static Dictionary<string, object> GetDictionary(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return new Dictionary<string, object>();
            return dict[key] as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
    }

    internal static class NativeLauncher
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint MEM_COMMIT = 0x1000;
        private const uint MEM_RESERVE = 0x2000;
        private const uint MEM_RELEASE = 0x8000;
        private const uint PAGE_READWRITE = 0x04;
        private const uint PAGE_EXECUTE_READWRITE = 0x40;
        private const uint PROCESS_ALL_INJECTION_ACCESS = 0x0002 | 0x0400 | 0x0008 | 0x0020 | 0x0010;
        private const uint WAIT_INFINITE = 0xFFFFFFFF;
        private const uint STILL_ACTIVE = 259;
        private const uint STARTF_USESHOWWINDOW = 0x00000001;
        private const short SW_SHOWNORMAL = 1;

        public sealed class SuspendedProcess
        {
            public IntPtr ProcessHandle;
            public IntPtr ThreadHandle;
            public int ProcessId;
        }

        public static SuspendedProcess CreateSuspended(string exePath, string exeParam, Dictionary<string, string> env, bool userPower)
        {
            var startupInfo = new NativeMethods.STARTUPINFO();
            startupInfo.cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFO));
            startupInfo.lpDesktop = "winsta0\\default";
            startupInfo.dwFlags = (int)STARTF_USESHOWWINDOW;
            startupInfo.wShowWindow = SW_SHOWNORMAL;
            var processInfo = new NativeMethods.PROCESS_INFORMATION();
            var commandLine = BuildCommandLine(exePath, exeParam);
            HelperLog.Write("CreateSuspended=> commandLine={0}, user_power={1}, isAdmin={2}, currentDirectory={3}, desktop={4}, show={5}",
                commandLine,
                userPower,
                IsAdministrator(),
                Path.GetDirectoryName(exePath),
                startupInfo.lpDesktop,
                startupInfo.wShowWindow);
            if (userPower && IsAdministrator())
            {
                HelperLog.Write("CreateSuspended=> using active user token branch.");
                var userTokenCreated = CreateProcessWithActiveUserToken(
                    exePath,
                    commandLine,
                    env,
                    Path.GetDirectoryName(exePath),
                    ref startupInfo,
                    out processInfo);
                if (!userTokenCreated) throw LastWin32("CreateProcessWithTokenW failed");
                HelperLog.Write("CreateSuspended=> CreateProcessWithTokenW ok, pid={0}", processInfo.dwProcessId);

                return new SuspendedProcess
                {
                    ProcessHandle = processInfo.hProcess,
                    ThreadHandle = processInfo.hThread,
                    ProcessId = (int)processInfo.dwProcessId
                };
            }

            var envBlock = BuildEnvironmentBlock(env);
            var envPtr = Marshal.StringToHGlobalUni(envBlock);

            try
            {
                HelperLog.Write("CreateSuspended=> using CreateProcessW branch.");
                var ok = NativeMethods.CreateProcessW(
                    exePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                    envPtr,
                    Path.GetDirectoryName(exePath),
                    ref startupInfo,
                    out processInfo);

                if (!ok) throw LastWin32("CreateProcessW failed");
                HelperLog.Write("CreateSuspended=> CreateProcessW ok, pid={0}", processInfo.dwProcessId);

                return new SuspendedProcess
                {
                    ProcessHandle = processInfo.hProcess,
                    ThreadHandle = processInfo.hThread,
                    ProcessId = (int)processInfo.dwProcessId
                };
            }
            finally
            {
                Marshal.FreeHGlobal(envPtr);
            }
        }

        private static bool CreateProcessWithActiveUserToken(
            string exePath,
            StringBuilder commandLine,
            Dictionary<string, string> env,
            string currentDirectory,
            ref NativeMethods.STARTUPINFO startupInfo,
            out NativeMethods.PROCESS_INFORMATION processInfo)
        {
            var explorerProcess = FindExplorerProcessInCurrentSession();
            if (explorerProcess == null) throw new InvalidOperationException("explorer.exe was not found for active user token");
            HelperLog.Write("CreateProcessWithActiveUserToken=> explorer pid={0}, session={1}, path={2}",
                explorerProcess.Id,
                explorerProcess.SessionId,
                SafeProcessPath(explorerProcess));

            IntPtr explorerToken = IntPtr.Zero;
            IntPtr primaryToken = IntPtr.Zero;
            IntPtr userEnvPtr = IntPtr.Zero;
            IntPtr mergedEnvPtr = IntPtr.Zero;
            try
            {
                if (!NativeMethods.OpenProcessToken(
                    explorerProcess.Handle,
                    NativeMethods.TOKEN_DUPLICATE | NativeMethods.TOKEN_ASSIGN_PRIMARY | NativeMethods.TOKEN_QUERY,
                    out explorerToken))
                {
                    throw LastWin32("OpenProcessToken explorer.exe failed");
                }
                HelperLog.Write("CreateProcessWithActiveUserToken=> explorer token user={0}", SafeTokenUser(explorerToken));

                if (!NativeMethods.DuplicateTokenEx(
                    explorerToken,
                    NativeMethods.TOKEN_ASSIGN_PRIMARY |
                    NativeMethods.TOKEN_DUPLICATE |
                    NativeMethods.TOKEN_IMPERSONATE |
                    NativeMethods.TOKEN_QUERY |
                    NativeMethods.TOKEN_ADJUST_DEFAULT |
                    NativeMethods.TOKEN_ADJUST_SESSIONID,
                    IntPtr.Zero,
                    NativeMethods.SECURITY_IMPERSONATION,
                    NativeMethods.TOKEN_PRIMARY,
                    out primaryToken))
                {
                    throw LastWin32("DuplicateTokenEx explorer.exe failed");
                }
                HelperLog.Write("CreateProcessWithActiveUserToken=> duplicated primary token user={0}", SafeTokenUser(primaryToken));

                if (!NativeMethods.CreateEnvironmentBlock(out userEnvPtr, primaryToken, false))
                {
                    throw LastWin32("CreateEnvironmentBlock failed");
                }

                var mergedEnv = ReadEnvironmentBlock(userEnvPtr);
                OverlayLaunchEnvironment(mergedEnv, env);
                HelperLog.Write("CreateProcessWithActiveUserToken=> user env USERPROFILE={0}, LOCALAPPDATA={1}, APPDATA={2}, TEMP={3}, JS_URL={4}, JS_DATA={5}, USE_DEVTOOL={6}",
                    GetDictionaryValue(mergedEnv, "USERPROFILE"),
                    GetDictionaryValue(mergedEnv, "LOCALAPPDATA"),
                    GetDictionaryValue(mergedEnv, "APPDATA"),
                    GetDictionaryValue(mergedEnv, "TEMP"),
                    GetDictionaryValue(mergedEnv, "JS_URL"),
                    GetDictionaryValue(mergedEnv, "JS_DATA"),
                    GetDictionaryValue(mergedEnv, "USE_DEVTOOL"));
                mergedEnvPtr = Marshal.StringToHGlobalUni(BuildEnvironmentBlock(mergedEnv));

                return NativeMethods.CreateProcessWithTokenW(
                    primaryToken,
                    NativeMethods.LOGON_WITH_PROFILE,
                    exePath,
                    commandLine,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                    mergedEnvPtr,
                    currentDirectory,
                    ref startupInfo,
                    out processInfo);
            }
            finally
            {
                if (mergedEnvPtr != IntPtr.Zero) Marshal.FreeHGlobal(mergedEnvPtr);
                if (userEnvPtr != IntPtr.Zero) NativeMethods.DestroyEnvironmentBlock(userEnvPtr);
                if (primaryToken != IntPtr.Zero) NativeMethods.CloseHandle(primaryToken);
                if (explorerToken != IntPtr.Zero) NativeMethods.CloseHandle(explorerToken);
                explorerProcess.Dispose();
            }
        }

        private static void OverlayLaunchEnvironment(Dictionary<string, string> target, Dictionary<string, string> source)
        {
            CopyEnvValue(target, source, "JS_URL");
            CopyEnvValue(target, source, "JS_DATA");
            CopyEnvValue(target, source, "WS_URL");
            CopyEnvValue(target, source, "USE_DEVTOOL");
        }

        private static void CopyEnvValue(Dictionary<string, string> target, Dictionary<string, string> source, string key)
        {
            if (source.ContainsKey(key)) target[key] = source[key] ?? "";
        }

        private static Dictionary<string, string> ReadEnvironmentBlock(IntPtr envPtr)
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var offset = 0;
            while (true)
            {
                var entry = Marshal.PtrToStringUni(IntPtr.Add(envPtr, offset));
                if (String.IsNullOrEmpty(entry)) break;
                var separator = entry.IndexOf('=');
                if (separator > 0)
                {
                    env[entry.Substring(0, separator)] = entry.Substring(separator + 1);
                }
                offset += (entry.Length + 1) * 2;
            }
            return env;
        }

        private static string GetDictionaryValue(Dictionary<string, string> dict, string key)
        {
            return dict.ContainsKey(key) ? dict[key] : "";
        }

        private static string SafeProcessPath(Process process)
        {
            try { return process.MainModule.FileName; } catch { return ""; }
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
                return "unknown:" + ex.Message;
            }
        }

        private static Process FindExplorerProcessInCurrentSession()
        {
            var sessionId = Process.GetCurrentProcess().SessionId;
            foreach (var process in Process.GetProcessesByName("explorer"))
            {
                try
                {
                    if (process.SessionId == sessionId) return process;
                    process.Dispose();
                }
                catch
                {
                    process.Dispose();
                }
            }
            return null;
        }

        private static bool IsAdministrator()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        public static void InjectDll(int pid, IntPtr mainThreadHandle, string dllPath, string requestedMode)
        {
            var mode = ResolveInjectMode(requestedMode);
            HelperLog.Write("InjectDll=> pid={0}, dllPath={1}, mode={2}", pid, dllPath, mode);
            var processHandle = NativeMethods.OpenProcess(PROCESS_ALL_INJECTION_ACCESS, false, (uint)pid);
            if (processHandle == IntPtr.Zero) throw LastWin32("OpenProcess failed");

            IntPtr remoteAddress = IntPtr.Zero;
            IntPtr threadHandle = IntPtr.Zero;
            try
            {
                if (String.Equals(mode, "thread-context-w", StringComparison.OrdinalIgnoreCase))
                {
                    InjectDllWithThreadContext(processHandle, mainThreadHandle, dllPath);
                    return;
                }

                var useUnicode = String.Equals(mode, "remote-thread-w", StringComparison.OrdinalIgnoreCase);
                var loadLibraryName = useUnicode ? "LoadLibraryW" : "LoadLibraryA";
                var dllBytes = useUnicode ? Encoding.Unicode.GetBytes(dllPath + "\0") : Encoding.Default.GetBytes(dllPath + "\0");
                remoteAddress = NativeMethods.VirtualAllocEx(processHandle, IntPtr.Zero, (UIntPtr)dllBytes.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                if (remoteAddress == IntPtr.Zero) throw LastWin32("VirtualAllocEx failed");
                HelperLog.Write("InjectDll=> allocated remote bytes={0}", dllBytes.Length);

                UIntPtr written;
                if (!NativeMethods.WriteProcessMemory(processHandle, remoteAddress, dllBytes, (UIntPtr)dllBytes.Length, out written) || written.ToUInt64() != (ulong)dllBytes.Length)
                {
                    throw LastWin32("WriteProcessMemory failed");
                }
                HelperLog.Write("InjectDll=> wrote bytes={0}", written);

                var kernel32 = NativeMethods.GetModuleHandleW("kernel32.dll");
                var loadLibrary = NativeMethods.GetProcAddress(kernel32, loadLibraryName);
                if (loadLibrary == IntPtr.Zero) throw LastWin32("GetProcAddress " + loadLibraryName + " failed");

                threadHandle = NativeMethods.CreateRemoteThread(processHandle, IntPtr.Zero, UIntPtr.Zero, loadLibrary, remoteAddress, 0, IntPtr.Zero);
                if (threadHandle == IntPtr.Zero) throw LastWin32("CreateRemoteThread failed");

                NativeMethods.WaitForSingleObject(threadHandle, WAIT_INFINITE);
                uint threadExitCode;
                if (!NativeMethods.GetExitCodeThread(threadHandle, out threadExitCode)) throw LastWin32("GetExitCodeThread failed");
                HelperLog.Write("InjectDll=> {0} remote thread completed, exitCode=0x{1:X8}.", loadLibraryName, threadExitCode);
                if (threadExitCode == 0 || threadExitCode == STILL_ACTIVE) throw new InvalidOperationException(loadLibraryName + " returned invalid module handle: 0x" + threadExitCode.ToString("X8"));
            }
            finally
            {
                if (threadHandle != IntPtr.Zero) NativeMethods.CloseHandle(threadHandle);
                if (remoteAddress != IntPtr.Zero) NativeMethods.VirtualFreeEx(processHandle, remoteAddress, UIntPtr.Zero, MEM_RELEASE);
                NativeMethods.CloseHandle(processHandle);
            }
        }

        private static void InjectDllWithThreadContext(IntPtr processHandle, IntPtr mainThreadHandle, string dllPath)
        {
            if (mainThreadHandle == IntPtr.Zero) throw new InvalidOperationException("main thread handle is required for thread-context injection.");

            var kernel32 = NativeMethods.GetModuleHandleW("kernel32.dll");
            var loadLibrary = NativeMethods.GetProcAddress(kernel32, "LoadLibraryW");
            if (loadLibrary == IntPtr.Zero) throw LastWin32("GetProcAddress LoadLibraryW failed");

            var dllBytes = Encoding.Unicode.GetBytes(dllPath + "\0");
            var codeLength = BuildThreadContextLoader(0, 0, 0).Length;
            var totalLength = codeLength + dllBytes.Length;
            var remoteBase = NativeMethods.VirtualAllocEx(processHandle, IntPtr.Zero, (UIntPtr)totalLength, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
            if (remoteBase == IntPtr.Zero) throw LastWin32("VirtualAllocEx thread-context failed");

            var context = new X64ThreadContext(mainThreadHandle);
            var originalRip = context.Rip;
            var remoteCode = remoteBase.ToInt64();
            var remoteDllPath = remoteCode + codeLength;
            var loader = BuildThreadContextLoader((ulong)remoteDllPath, (ulong)loadLibrary.ToInt64(), originalRip);
            var payload = new byte[totalLength];
            Buffer.BlockCopy(loader, 0, payload, 0, loader.Length);
            Buffer.BlockCopy(dllBytes, 0, payload, loader.Length, dllBytes.Length);

            UIntPtr written;
            if (!NativeMethods.WriteProcessMemory(processHandle, remoteBase, payload, (UIntPtr)payload.Length, out written) || written.ToUInt64() != (ulong)payload.Length)
            {
                throw LastWin32("WriteProcessMemory thread-context failed");
            }

            context.Rip = (ulong)remoteCode;
            context.Apply();
            HelperLog.Write("InjectDll=> thread-context loader installed, originalRip=0x{0:X16}, remoteCode=0x{1:X16}, remoteBytes={2}", originalRip, remoteCode, payload.Length);
        }

        private static byte[] BuildThreadContextLoader(ulong dllPathAddress, ulong loadLibraryWAddress, ulong returnAddress)
        {
            var bytes = new List<byte>();
            Action<byte[]> emit = value => bytes.AddRange(value);
            Action<ulong> emitU64 = value => bytes.AddRange(BitConverter.GetBytes(value));

            emit(new byte[] { 0x9C }); // pushfq
            emit(new byte[] { 0x50, 0x51, 0x52, 0x53, 0x55, 0x56, 0x57 });
            emit(new byte[] { 0x41, 0x50, 0x41, 0x51, 0x41, 0x52, 0x41, 0x53, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57 });
            emit(new byte[] { 0x48, 0x89, 0xE5 }); // mov rbp, rsp
            emit(new byte[] { 0x48, 0x83, 0xE4, 0xF0 }); // and rsp, -16
            emit(new byte[] { 0x48, 0x83, 0xEC, 0x20 }); // sub rsp, 0x20
            emit(new byte[] { 0x48, 0xB9 }); emitU64(dllPathAddress); // mov rcx, dllPath
            emit(new byte[] { 0x48, 0xB8 }); emitU64(loadLibraryWAddress); // mov rax, LoadLibraryW
            emit(new byte[] { 0xFF, 0xD0 }); // call rax
            emit(new byte[] { 0x48, 0x89, 0xEC }); // mov rsp, rbp
            emit(new byte[] { 0x41, 0x5F, 0x41, 0x5E, 0x41, 0x5D, 0x41, 0x5C, 0x41, 0x5B, 0x41, 0x5A, 0x41, 0x59, 0x41, 0x58 });
            emit(new byte[] { 0x5F, 0x5E, 0x5D, 0x5B, 0x5A, 0x59, 0x58 });
            emit(new byte[] { 0x9D }); // popfq
            emit(new byte[] { 0x49, 0xBB }); emitU64(returnAddress); // mov r11, original rip
            emit(new byte[] { 0x41, 0xFF, 0xE3 }); // jmp r11
            return bytes.ToArray();
        }

        private static string ResolveInjectMode(string requestedMode)
        {
            var mode = !String.IsNullOrWhiteSpace(requestedMode)
                ? requestedMode
                : Environment.GetEnvironmentVariable("PDD_FUKE_INJECT_MODE");
            if (String.IsNullOrWhiteSpace(mode)) return "remote-thread-a";
            mode = mode.Trim().ToLowerInvariant();
            if (mode == "remote-thread-a" || mode == "remote-thread-w" || mode == "thread-context-w") return mode;
            throw new ArgumentException("Unsupported inject_mode: " + mode);
        }

        public static void EnableLaunchPrivileges()
        {
            EnablePrivilege("SeAssignPrimaryTokenPrivilege");
            EnablePrivilege("SeImpersonatePrivilege");
            EnablePrivilege("SeIncreaseQuotaPrivilege");
            EnablePrivilege("SeDebugPrivilege");
        }

        private static void EnablePrivilege(string privilegeName)
        {
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!NativeMethods.OpenProcessToken(
                    Process.GetCurrentProcess().Handle,
                    NativeMethods.TOKEN_ADJUST_PRIVILEGES | NativeMethods.TOKEN_QUERY,
                    out token))
                {
                    HelperLog.Write("EnablePrivilege=> OpenProcessToken failed for {0}: {1}", privilegeName, LastWin32Message());
                    return;
                }

                NativeMethods.LUID luid;
                if (!NativeMethods.LookupPrivilegeValueW(null, privilegeName, out luid))
                {
                    HelperLog.Write("EnablePrivilege=> LookupPrivilegeValueW failed for {0}: {1}", privilegeName, LastWin32Message());
                    return;
                }

                var privileges = new NativeMethods.TOKEN_PRIVILEGES
                {
                    PrivilegeCount = 1,
                    Luid = luid,
                    Attributes = NativeMethods.SE_PRIVILEGE_ENABLED
                };

                if (!NativeMethods.AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
                {
                    HelperLog.Write("EnablePrivilege=> AdjustTokenPrivileges failed for {0}: {1}", privilegeName, LastWin32Message());
                    return;
                }

                var code = Marshal.GetLastWin32Error();
                if (code != 0)
                {
                    HelperLog.Write("EnablePrivilege=> {0} not assigned: {1} ({2})", privilegeName, new System.ComponentModel.Win32Exception(code).Message, code);
                    return;
                }

                HelperLog.Write("EnablePrivilege=> enabled {0}", privilegeName);
            }
            finally
            {
                if (token != IntPtr.Zero) NativeMethods.CloseHandle(token);
            }
        }

        private static string LastWin32Message()
        {
            var code = Marshal.GetLastWin32Error();
            return code + " (" + new System.ComponentModel.Win32Exception(code).Message + ")";
        }

        private static string BuildEnvironmentBlock(Dictionary<string, string> env)
        {
            var keys = new List<string>(env.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            var builder = new StringBuilder();
            foreach (var key in keys)
            {
                if (String.IsNullOrEmpty(key)) continue;
                builder.Append(key).Append('=').Append(env[key] ?? "").Append('\0');
            }
            builder.Append('\0');
            return builder.ToString();
        }

        private static StringBuilder BuildCommandLine(string exePath, string exeParam)
        {
            var builder = new StringBuilder(Quote(exePath));
            builder.Append(' ');
            if (!String.IsNullOrWhiteSpace(exeParam)) builder.Append(exeParam);
            return builder;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static Exception LastWin32(string label)
        {
            var code = Marshal.GetLastWin32Error();
            var message = new System.ComponentModel.Win32Exception(code).Message;
            return new InvalidOperationException(label + ": " + code + " (" + message + ")");
        }
    }

    internal static class NativeMethods
    {
        public const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
        public const uint TOKEN_DUPLICATE = 0x0002;
        public const uint TOKEN_IMPERSONATE = 0x0004;
        public const uint TOKEN_QUERY = 0x0008;
        public const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
        public const uint TOKEN_ADJUST_DEFAULT = 0x0080;
        public const uint TOKEN_ADJUST_SESSIONID = 0x0100;
        public const int SECURITY_IMPERSONATION = 2;
        public const int TOKEN_PRIMARY = 1;
        public const uint LOGON_WITH_PROFILE = 0x00000001;
        public const uint SE_PRIVILEGE_ENABLED = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        public struct LUID
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct TOKEN_PRIVILEGES
        {
            public uint PrivilegeCount;
            public LUID Luid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessW(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint flAllocationType, uint flProtect);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesWritten);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr GetModuleHandleW(string lpModuleName);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        public static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateRemoteThread(IntPtr hProcess, IntPtr lpThreadAttributes, UIntPtr dwStackSize, IntPtr lpStartAddress, IntPtr lpParameter, uint dwCreationFlags, IntPtr lpThreadId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeThread(IntPtr hThread, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetThreadContext(IntPtr hThread, IntPtr lpContext);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetThreadContext(IntPtr hThread, IntPtr lpContext);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool LookupPrivilegeValueW(string lpSystemName, string lpName, out LUID lpLuid);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges, ref TOKEN_PRIVILEGES NewState, uint BufferLength, IntPtr PreviousState, IntPtr ReturnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(
            IntPtr hExistingToken,
            uint dwDesiredAccess,
            IntPtr lpTokenAttributes,
            int ImpersonationLevel,
            int TokenType,
            out IntPtr phNewToken);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessWithTokenW(
            IntPtr hToken,
            uint dwLogonFlags,
            string lpApplicationName,
            StringBuilder lpCommandLine,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);
    }

    internal sealed class X64ThreadContext : IDisposable
    {
        private const int ContextBufferSize = 1232;
        private const int ContextFlagsOffset = 48;
        private const int RipOffset = 248;
        private const uint ContextControl = 0x00100001;
        private readonly IntPtr _raw;
        private readonly IntPtr _aligned;
        private readonly IntPtr _threadHandle;

        public X64ThreadContext(IntPtr threadHandle)
        {
            _threadHandle = threadHandle;
            _raw = Marshal.AllocHGlobal(ContextBufferSize + 16);
            var raw = _raw.ToInt64();
            _aligned = new IntPtr((raw + 15) & ~15L);
            for (var i = 0; i < ContextBufferSize; i++) Marshal.WriteByte(_aligned, i, 0);
            Marshal.WriteInt32(_aligned, ContextFlagsOffset, unchecked((int)ContextControl));
            if (!NativeMethods.GetThreadContext(_threadHandle, _aligned))
            {
                throw LastWin32("GetThreadContext failed");
            }
        }

        public ulong Rip
        {
            get { return unchecked((ulong)Marshal.ReadInt64(_aligned, RipOffset)); }
            set { Marshal.WriteInt64(_aligned, RipOffset, unchecked((long)value)); }
        }

        public void Apply()
        {
            Marshal.WriteInt32(_aligned, ContextFlagsOffset, unchecked((int)ContextControl));
            if (!NativeMethods.SetThreadContext(_threadHandle, _aligned))
            {
                throw LastWin32("SetThreadContext failed");
            }
        }

        public void Dispose()
        {
            if (_raw != IntPtr.Zero) Marshal.FreeHGlobal(_raw);
        }

        private static Exception LastWin32(string label)
        {
            var code = Marshal.GetLastWin32Error();
            var message = new System.ComponentModel.Win32Exception(code).Message;
            return new InvalidOperationException(label + ": " + code + " (" + message + ")");
        }
    }

    internal static class HelperLog
    {
        private static readonly object Sync = new object();

        public static void Write(string format, params object[] args)
        {
            try
            {
                var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (String.IsNullOrWhiteSpace(localAppData)) localAppData = Path.GetTempPath();
                var dir = Path.Combine(localAppData, "huihui", "logs", "Extend");
                Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, "fuke-launch-csharp.txt");
                var message = args == null || args.Length == 0 ? format : String.Format(format, args);
                var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "    [DEBU]" + message + Environment.NewLine;
                lock (Sync)
                {
                    File.AppendAllText(path, line, Encoding.UTF8);
                }
            }
            catch
            {
            }
        }
    }
}
