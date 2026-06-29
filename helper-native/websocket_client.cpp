#include "websocket_client.h"

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

#include <winsock2.h>

#include <atomic>
#include <condition_variable>
#include <mutex>

namespace websocket {

Client::Client(std::string url, MessageHandler on_message, CloseHandler on_close)
    : url_(std::move(url)), on_message_(std::move(on_message)), on_close_(std::move(on_close)) {}

Client::~Client() = default;

bool initialize_wsa_event_select_model() {
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
        return false;
    }
    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        WSACleanup();
        return false;
    }
    WSAEVENT event = WSACreateEvent();
    if (event == WSA_INVALID_EVENT) {
        closesocket(sock);
        WSACleanup();
        return false;
    }
    WSAEventSelect(sock, event, FD_CONNECT | FD_READ | FD_WRITE | FD_CLOSE);
    WSANETWORKEVENTS network_events{};
    WSAEnumNetworkEvents(sock, event, &network_events);
    WSAWaitForMultipleEvents(1, &event, TRUE, 0, FALSE);
    WSACloseEvent(event);
    closesocket(sock);
    WSACleanup();
    return true;
}

bool Client::send(const std::string& text) {
    ix::WebSocket socket;
    socket.setUrl(url_);
    socket.disableAutomaticReconnection();
    socket.start();
    const auto sent = socket.sendText(text);
    socket.stop();
    return sent.success;
}

int Client::run() {
    initialize_wsa_event_select_model();
    ix::initNetSystem();

    ix::WebSocket socket;
    socket.setUrl(url_);
    socket.disableAutomaticReconnection();
    socket.setPingInterval(30);

    std::mutex mutex;
    std::condition_variable cv;
    std::atomic_bool opened = false;
    std::atomic_bool closed = false;

    socket.setOnMessageCallback([&](const ix::WebSocketMessagePtr& message) {
        if (message->type == ix::WebSocketMessageType::Open) {
            opened = true;
            cv.notify_all();
            return;
        }
        if (message->type == ix::WebSocketMessageType::Message) {
            const auto response = on_message_(message->str);
            if (!response.empty()) {
                socket.sendText(response);
            }
            return;
        }
        if (message->type == ix::WebSocketMessageType::Close ||
            message->type == ix::WebSocketMessageType::Error) {
            closed = true;
            if (on_close_) {
                on_close_();
            }
            cv.notify_all();
        }
    });

    socket.start();
    {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait(lock, [&] { return opened.load() || closed.load(); });
    }
    if (opened) {
        socket.sendText("{\"type\":\"event\",\"body\":{\"name\":\"hello\",\"param\":{\"platform\":\"fuke-helper\",\"version\":\"pdd-fuke-helper\"}}}");
    }

    {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait(lock, [&] { return closed.load() || stopped_; });
    }
    socket.stop();
    ix::uninitNetSystem();
    return 0;
}

void Client::stop() {
    stopped_ = true;
}

}  // namespace websocket
