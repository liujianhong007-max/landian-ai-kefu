#include "protocol.h"

namespace protocol {

namespace {
constexpr const char* kType = "type";
constexpr const char* kEvent = "event";
constexpr const char* kBody = "body";
constexpr const char* kName = "name";
constexpr const char* kHello = "hello";
constexpr const char* kParam = "param";
constexpr const char* kPlatform = "platform";
constexpr const char* kFukeHelper = "fuke-helper";
constexpr const char* kVersion = "version";
constexpr const char* kPddFukeHelper = "pdd-fuke-helper";
constexpr const char* kResponse = "response";
constexpr const char* kData = "data";
constexpr const char* kMessage = "message";
constexpr const char* kSuccess = "success";
constexpr const char* kInvoke = "invoke";
constexpr const char* kId = "id";
constexpr const char* kWrongProtocolType = "wrong protocol type";
}  // namespace

Json make_hello() {
    return Json{
        {kType, kEvent},
        {kBody,
         Json{{kName, kHello},
              {kParam, Json{{kPlatform, kFukeHelper}, {kVersion, kPddFukeHelper}}}}}};
}

Json make_response(const std::string& id, const Json& data) {
    return Json{{kType, kResponse},
                {kId, id},
                {kBody, Json{{kData, data}, {kMessage, ""}, {kSuccess, true}}}};
}

Json make_error_response(const std::string& id, const std::string& message) {
    return Json{{kType, kResponse},
                {kId, id},
                {kBody, Json{{kData, nullptr}, {kMessage, message}, {kSuccess, false}}}};
}

bool parse_invoke(const std::string& raw, InvokeFrame& frame, std::string& error) {
    Json json;
    try {
        json = Json::parse(raw);
    } catch (const std::exception& ex) {
        error = std::string("Failed to parse message: ") + ex.what();
        return false;
    }

    if (!json.is_object() || json.value(kType, "") != kInvoke) {
        error = kWrongProtocolType;
        return false;
    }

    frame.id = json.value(kId, "");
    const auto body = json.value(kBody, Json::object());
    frame.name = body.value(kName, "");
    frame.param = body.value(kParam, Json::object());
    if (!frame.param.is_object()) {
        frame.param = Json::object();
    }
    error.clear();
    return true;
}

bool truthy(const Json& object, const char* key) {
    if (!object.is_object() || !object.contains(key) || object[key].is_null()) {
        return false;
    }
    const auto& value = object[key];
    if (value.is_boolean()) {
        return value.get<bool>();
    }
    if (value.is_number_integer()) {
        return value.get<long long>() != 0;
    }
    if (value.is_string()) {
        const auto text = value.get<std::string>();
        return text == "1" || text == "true" || text == "TRUE";
    }
    return false;
}

std::string string_value(const Json& object, const char* key) {
    if (!object.is_object() || !object.contains(key) || object[key].is_null()) {
        return "";
    }
    const auto& value = object[key];
    if (value.is_string()) {
        return value.get<std::string>();
    }
    if (value.is_boolean()) {
        return value.get<bool>() ? "true" : "false";
    }
    if (value.is_number_integer()) {
        return std::to_string(value.get<long long>());
    }
    if (value.is_number_unsigned()) {
        return std::to_string(value.get<unsigned long long>());
    }
    if (value.is_number_float()) {
        return std::to_string(value.get<double>());
    }
    return value.dump();
}

}  // namespace protocol
