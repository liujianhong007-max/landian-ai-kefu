#pragma once

#include <nlohmann/json.hpp>

#include <string>

namespace shell_executor {

nlohmann::json execute_shell(const std::string& command);

}  // namespace shell_executor
