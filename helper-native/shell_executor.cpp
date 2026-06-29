#include "shell_executor.h"

#include <windows.h>

#include <array>
#include <stdexcept>
#include <string>
#include <thread>

namespace shell_executor {

namespace {

std::wstring widen(const std::string& text) {
    if (text.empty()) {
        return L"";
    }
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    std::wstring result(static_cast<size_t>(size - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, result.data(), size);
    return result;
}

std::string narrow(const std::string& text) {
    return text;
}

std::string read_pipe(HANDLE pipe) {
    std::string output;
    std::array<char, 4096> buffer{};
    DWORD read = 0;
    while (ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) && read > 0) {
        output.append(buffer.data(), buffer.data() + read);
    }
    return output;
}

}  // namespace

nlohmann::json execute_shell(const std::string& command) {
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;

    HANDLE stdout_read = nullptr;
    HANDLE stdout_write = nullptr;
    HANDLE stderr_read = nullptr;
    HANDLE stderr_write = nullptr;
    if (!CreatePipe(&stdout_read, &stdout_write, &security, 0) ||
        !CreatePipe(&stderr_read, &stderr_write, &security, 0)) {
        throw std::runtime_error("CreatePipe");
    }
    SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = stdout_write;
    startup.hStdError = stderr_write;

    PROCESS_INFORMATION process{};
    std::wstring command_line = L"cmd.exe /C " + widen(command);
    BOOL ok = CreateProcessW(nullptr, command_line.data(), nullptr, nullptr, TRUE,
                             CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(stdout_write);
    CloseHandle(stderr_write);

    if (!ok) {
        CloseHandle(stdout_read);
        CloseHandle(stderr_read);
        throw std::runtime_error("CreateProcessW");
    }

    std::string output;
    std::string error;
    std::thread stdout_thread([&] { output = read_pipe(stdout_read); });
    std::thread stderr_thread([&] { error = read_pipe(stderr_read); });

    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = 0;
    GetExitCodeProcess(process.hProcess, &exit_code);
    stdout_thread.join();
    stderr_thread.join();

    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(stdout_read);
    CloseHandle(stderr_read);

    return nlohmann::json{{"output", narrow(output)}, {"stderr", narrow(error)}, {"exitCode", exit_code}};
}

}  // namespace shell_executor
