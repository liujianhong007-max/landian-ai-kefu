#pragma once

#include <functional>
#include <string>

namespace websocket {

using MessageHandler = std::function<std::string(const std::string&)>;
using CloseHandler = std::function<void()>;

class Client {
public:
    Client(std::string url, MessageHandler on_message, CloseHandler on_close);
    ~Client();

    int run();
    void stop();
    bool send(const std::string& text);

private:
    std::string url_;
    MessageHandler on_message_;
    CloseHandler on_close_;
    bool stopped_ = false;
};

bool initialize_wsa_event_select_model();

}  // namespace websocket
