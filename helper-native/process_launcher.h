#pragma once

#include <nlohmann/json.hpp>

#include <windows.h>

#include <string>

namespace process_launcher {

struct SuspendedProcess {
    HANDLE process_handle = nullptr;
    HANDLE thread_handle = nullptr;
    DWORD process_id = 0;
};

nlohmann::json launch_platform(const nlohmann::json& param);
SuspendedProcess create_suspended(const std::wstring& exe_path,
                                  const std::wstring& exe_param,
                                  const nlohmann::json& param,
                                  bool user_power);
void inject_dll(DWORD pid, const std::string& dll_path);

}  // namespace process_launcher
