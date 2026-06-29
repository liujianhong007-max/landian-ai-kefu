#include "privilege.h"
#include "process_launcher.h"
#include "protocol.h"
#include "shell_executor.h"
#include "websocket_client.h"

#include <shellapi.h>
#include <windows.h>

#include <filesystem>
#include <stdexcept>
#include <string>

namespace {

std::string narrow_utf8(const std::wstring& text) {
    if (text.empty()) {
        return "";
    }
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(size - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, result.data(), size, nullptr, nullptr);
    return result;
}

std::wstring module_path() {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    path.resize(size);
    return path;
}

std::wstring command_line_argument(int index) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::wstring value;
    if (argv && index < argc) {
        value = argv[index];
    }
    if (argv) {
        LocalFree(argv);
    }
    return value;
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

std::wstring command_line_parameters() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::wstring result;
    if (argv) {
        for (int i = 1; i < argc; ++i) {
            if (!result.empty()) {
                result.push_back(L' ');
            }
            result.append(quote_windows_arg(argv[i]));
        }
        LocalFree(argv);
    }
    return result;
}

bool launch_auto_update_if_present() {
    const auto exe = std::filesystem::path(module_path());
    const auto dir = exe.parent_path();
    auto updater = dir / L"assets" / L"AutoUpdate.exe";
    if (!std::filesystem::exists(updater)) {
        updater = dir / L"AutoUpdate.exe";
    }
    if (!std::filesystem::exists(updater)) {
        return false;
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    auto command = updater.wstring();
    if (CreateProcessW(updater.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr,
                       updater.parent_path().c_str(), &startup, &process)) {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return true;
    }
    return false;
}

bool self_elevate_if_requested() {
    wchar_t value[8]{};
    if (GetEnvironmentVariableW(L"PDD_FUKE_HELPER_ELEVATE", value, 8) == 0) {
        return false;
    }
    if (wcscmp(value, L"1") != 0 || privilege::is_administrator()) {
        return false;
    }

    SHELLEXECUTEINFOW info{};
    info.cbSize = sizeof(info);
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = L"runas";
    const auto exe = module_path();
    const auto parameters = command_line_parameters();
    info.lpFile = exe.c_str();
    info.lpParameters = parameters.c_str();
    info.nShow = SW_SHOWNORMAL;
    if (ShellExecuteExW(&info)) {
        if (info.hProcess) {
            CloseHandle(info.hProcess);
        }
        return true;
    }
    return false;
}

std::string handle_frame(const std::string& raw) {
    protocol::InvokeFrame frame;
    std::string error;
    if (!protocol::parse_invoke(raw, frame, error)) {
        if (error == "wrong protocol type") {
            return "";
        }
        return protocol::make_error_response("", error).dump();
    }

    try {
        nlohmann::json data;
        if (frame.name == "execute_shell") {
            data = shell_executor::execute_shell(protocol::string_value(frame.param, "command"));
        } else if (frame.name == "launch_platform") {
            data = process_launcher::launch_platform(frame.param);
        } else {
            throw std::runtime_error("Unknown message type: " + frame.name);
        }
        return protocol::make_response(frame.id, data).dump();
    } catch (const std::exception& ex) {
        return protocol::make_error_response(frame.id, ex.what()).dump();
    }
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
    if (self_elevate_if_requested()) {
        return 0;
    }

    privilege::enable_launch_privileges();
    launch_auto_update_if_present();

    auto ws_url = narrow_utf8(command_line_argument(1));
    if (ws_url.empty()) {
        ws_url = "ws://127.0.0.1:5555/Extend";
    }

    websocket::Client client(
        ws_url,
        [](const std::string& raw) { return handle_frame(raw); },
        [] {
            OutputDebugStringA("WebSocket disconnected, terminating process.");
            ExitProcess(0);
        });
    return client.run();
}
