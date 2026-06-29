#include "process_launcher.h"

#include "privilege.h"
#include "protocol.h"

#include <tlhelp32.h>
#include <userenv.h>
#include <wtsapi32.h>

#include <algorithm>
#include <filesystem>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace process_launcher {

namespace {

constexpr DWORD CREATE_FLAGS = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
constexpr DWORD PROCESS_ALL_INJECTION_ACCESS =
    PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ;
constexpr DWORD STILL_ACTIVE_CODE = 259;

std::wstring widen(const std::string& text) {
    if (text.empty()) {
        return L"";
    }
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    std::wstring result(static_cast<size_t>(size - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, result.data(), size);
    return result;
}

std::string narrow_ansi(const std::wstring& text) {
    if (text.empty()) {
        return "";
    }
    const int size = WideCharToMultiByte(CP_ACP, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(size - 1), '\0');
    WideCharToMultiByte(CP_ACP, 0, text.c_str(), -1, result.data(), size, nullptr, nullptr);
    return result;
}

std::wstring quote_windows_arg(const std::wstring& value) {
    if (value.empty()) {
        return L"\"\"";
    }
    if (value.find_first_of(L" \t\"") == std::wstring::npos) {
        return value;
    }
    std::wstring quoted = L"\"";
    for (wchar_t ch : value) {
        if (ch == L'\\' || ch == L'"') {
            quoted.push_back(L'\\');
        }
        quoted.push_back(ch);
    }
    quoted.push_back(L'"');
    return quoted;
}

std::wstring build_command_line(const std::wstring& exe_path, const std::wstring& exe_param) {
    auto command_line = quote_windows_arg(exe_path);
    if (!exe_param.empty()) {
        command_line.push_back(L' ');
        command_line.append(exe_param);
    }
    return command_line;
}

std::wstring environment_value(const wchar_t* key) {
    const DWORD needed = GetEnvironmentVariableW(key, nullptr, 0);
    if (needed == 0) {
        return L"";
    }
    std::wstring value(needed, L'\0');
    GetEnvironmentVariableW(key, value.data(), needed);
    value.resize(wcslen(value.c_str()));
    return value;
}

std::vector<wchar_t> build_environment_block(const nlohmann::json& param) {
    std::map<std::wstring, std::wstring, std::less<>> env;
    LPWCH block = GetEnvironmentStringsW();
    if (block) {
        for (LPWCH current = block; *current; current += wcslen(current) + 1) {
            std::wstring entry = current;
            const auto pos = entry.find(L'=');
            if (pos != std::wstring::npos && pos > 0) {
                env[entry.substr(0, pos)] = entry.substr(pos + 1);
            }
        }
        FreeEnvironmentStringsW(block);
    }

    env[L"JS_URL"] = widen(protocol::string_value(param, "js_url"));
    env[L"JS_DATA"] = widen(protocol::string_value(param, "js_data"));
    env[L"WS_URL"] = widen(protocol::string_value(param, "ws_url"));
    env[L"USE_DEVTOOL"] = protocol::truthy(param, "use_devtool") ? L"1" : L"0";

    std::vector<wchar_t> result;
    for (const auto& [key, value] : env) {
        std::wstring entry = key + L"=" + value;
        result.insert(result.end(), entry.begin(), entry.end());
        result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}

DWORD find_explorer_in_active_session() {
    const DWORD active_session = WTSGetActiveConsoleSessionId();
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return 0;
    }

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    DWORD pid = 0;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            DWORD session = 0;
            if (_wcsicmp(entry.szExeFile, L"explorer.exe") == 0 &&
                ProcessIdToSessionId(entry.th32ProcessID, &session) &&
                session == active_session) {
                pid = entry.th32ProcessID;
                break;
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return pid;
}

std::map<std::wstring, std::wstring, std::less<>> read_environment_block(void* env_block) {
    std::map<std::wstring, std::wstring, std::less<>> env;
    if (!env_block) {
        return env;
    }
    auto* current = static_cast<const wchar_t*>(env_block);
    while (*current) {
        std::wstring entry = current;
        const auto pos = entry.find(L'=');
        if (pos != std::wstring::npos && pos > 0) {
            env[entry.substr(0, pos)] = entry.substr(pos + 1);
        }
        current += entry.size() + 1;
    }
    return env;
}

std::vector<wchar_t> map_to_environment_block(const std::map<std::wstring, std::wstring, std::less<>>& env) {
    std::vector<wchar_t> result;
    for (const auto& [key, value] : env) {
        const auto entry = key + L"=" + value;
        result.insert(result.end(), entry.begin(), entry.end());
        result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}

SuspendedProcess create_with_active_user_token(const std::wstring& exe_path,
                                               std::wstring command_line,
                                               const std::wstring& current_directory,
                                               STARTUPINFOW& startup,
                                               const nlohmann::json& param) {
    const DWORD explorer_pid = find_explorer_in_active_session();
    if (explorer_pid == 0) {
        throw std::runtime_error("explorer.exe");
    }

    HANDLE explorer = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, explorer_pid);
    if (!explorer) {
        throw std::runtime_error("OpenProcess");
    }

    HANDLE explorer_token = nullptr;
    HANDLE primary_token = nullptr;
    void* user_env = nullptr;
    PROCESS_INFORMATION process{};
    try {
        if (!OpenProcessToken(explorer, TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY, &explorer_token)) {
            throw std::runtime_error("OpenProcessToken");
        }
        if (!DuplicateTokenEx(explorer_token,
                              TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE | TOKEN_QUERY |
                                  TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID,
                              nullptr, SecurityImpersonation, TokenPrimary, &primary_token)) {
            throw std::runtime_error("DuplicateTokenEx");
        }
        if (!CreateEnvironmentBlock(&user_env, primary_token, FALSE)) {
            throw std::runtime_error("CreateEnvironmentBlock");
        }

        auto merged = read_environment_block(user_env);
        merged[L"JS_URL"] = widen(protocol::string_value(param, "js_url"));
        merged[L"JS_DATA"] = widen(protocol::string_value(param, "js_data"));
        merged[L"WS_URL"] = widen(protocol::string_value(param, "ws_url"));
        merged[L"USE_DEVTOOL"] = protocol::truthy(param, "use_devtool") ? L"1" : L"0";
        auto env_block = map_to_environment_block(merged);

        if (!CreateProcessWithTokenW(primary_token, LOGON_WITH_PROFILE, exe_path.c_str(), command_line.data(),
                                     CREATE_FLAGS, env_block.data(), current_directory.c_str(), &startup,
                                     &process)) {
            throw std::runtime_error("CreateProcessWithTokenW");
        }
    } catch (...) {
        if (process.hThread) CloseHandle(process.hThread);
        if (process.hProcess) CloseHandle(process.hProcess);
        if (user_env) DestroyEnvironmentBlock(user_env);
        if (primary_token) CloseHandle(primary_token);
        if (explorer_token) CloseHandle(explorer_token);
        CloseHandle(explorer);
        throw;
    }

    if (user_env) DestroyEnvironmentBlock(user_env);
    if (primary_token) CloseHandle(primary_token);
    if (explorer_token) CloseHandle(explorer_token);
    CloseHandle(explorer);
    return {process.hProcess, process.hThread, process.dwProcessId};
}

}  // namespace

SuspendedProcess create_suspended(const std::wstring& exe_path,
                                  const std::wstring& exe_param,
                                  const nlohmann::json& param,
                                  bool user_power) {
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.lpDesktop = const_cast<LPWSTR>(L"winsta0\\default");
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_SHOWNORMAL;

    auto command_line = build_command_line(exe_path, exe_param);
    const auto current_directory = std::filesystem::path(exe_path).parent_path().wstring();

    if (user_power && privilege::is_administrator()) {
        return create_with_active_user_token(exe_path, command_line, current_directory, startup, param);
    }

    auto env_block = build_environment_block(param);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(exe_path.c_str(), command_line.data(), nullptr, nullptr, FALSE, CREATE_FLAGS,
                        env_block.data(), current_directory.c_str(), &startup, &process)) {
        throw std::runtime_error("CreateProcessW");
    }
    return {process.hProcess, process.hThread, process.dwProcessId};
}

void inject_dll(DWORD pid, const std::string& dll_path) {
    HANDLE process = OpenProcess(PROCESS_ALL_INJECTION_ACCESS, FALSE, pid);
    if (!process) {
        throw std::runtime_error("OpenProcess");
    }

    void* remote_address = nullptr;
    HANDLE thread = nullptr;
    try {
        const std::vector<char> dll_bytes(dll_path.c_str(), dll_path.c_str() + dll_path.size() + 1);
        remote_address = VirtualAllocEx(process, nullptr, dll_bytes.size(), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!remote_address) {
            throw std::runtime_error("VirtualAllocEx");
        }

        SIZE_T written = 0;
        if (!WriteProcessMemory(process, remote_address, dll_bytes.data(), dll_bytes.size(), &written) ||
            written != dll_bytes.size()) {
            throw std::runtime_error("WriteProcessMemory");
        }

        HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
        auto* load_library = reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(kernel32, "LoadLibraryA"));
        if (!load_library) {
            throw std::runtime_error("get LoadLibraryA address fail.");
        }

        thread = CreateRemoteThread(process, nullptr, 0, load_library, remote_address, 0, nullptr);
        if (!thread) {
            throw std::runtime_error("CreateRemoteThread");
        }

        WaitForSingleObject(thread, INFINITE);
        DWORD exit_code = 0;
        if (!GetExitCodeThread(thread, &exit_code)) {
            throw std::runtime_error("GetExitCodeThread");
        }
        if (exit_code == 0 || exit_code == STILL_ACTIVE_CODE) {
            throw std::runtime_error("LoadLibraryA");
        }
    } catch (...) {
        if (thread) CloseHandle(thread);
        if (remote_address) VirtualFreeEx(process, remote_address, 0, MEM_RELEASE);
        CloseHandle(process);
        throw;
    }

    CloseHandle(thread);
    VirtualFreeEx(process, remote_address, 0, MEM_RELEASE);
    CloseHandle(process);
}

nlohmann::json launch_platform(const nlohmann::json& param) {
    const auto exe_path_utf8 = protocol::string_value(param, "exe_path");
    const auto exe_param_utf8 = protocol::string_value(param, "exe_param");
    const auto dll_path_utf8 = protocol::string_value(param, "inject_dllpath");
    if (exe_path_utf8.empty()) {
        throw std::runtime_error("exe_path");
    }
    if (dll_path_utf8.empty()) {
        throw std::runtime_error("inject_dllpath");
    }

    const auto exe_path = widen(exe_path_utf8);
    const auto exe_param = widen(exe_param_utf8);
    const auto dll_path = widen(dll_path_utf8);
    if (!std::filesystem::exists(exe_path)) {
        throw std::runtime_error("exe_path");
    }
    if (!std::filesystem::exists(dll_path)) {
        throw std::runtime_error("inject_dllpath");
    }

    const bool user_power = protocol::truthy(param, "user_power");
    auto created = create_suspended(exe_path, exe_param, param, user_power);
    bool resumed = false;
    try {
        inject_dll(created.process_id, narrow_ansi(dll_path));
        ResumeThread(created.thread_handle);
        resumed = true;
        auto result = nlohmann::json{{"pid", created.process_id}};
        CloseHandle(created.thread_handle);
        CloseHandle(created.process_handle);
        return result;
    } catch (...) {
        if (!resumed) {
            TerminateProcess(created.process_handle, 1);
        }
        CloseHandle(created.thread_handle);
        CloseHandle(created.process_handle);
        throw;
    }

}

}  // namespace process_launcher
