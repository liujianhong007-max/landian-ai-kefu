#pragma once

#include <nlohmann/json.hpp>

#include <string>

namespace protocol {

using Json = nlohmann::json;

struct InvokeFrame {
    std::string id;
    std::string name;
    Json param;
};

Json make_hello();
Json make_response(const std::string& id, const Json& data);
Json make_error_response(const std::string& id, const std::string& message);
bool parse_invoke(const std::string& raw, InvokeFrame& frame, std::string& error);
bool truthy(const Json& object, const char* key);
std::string string_value(const Json& object, const char* key);

}  // namespace protocol
