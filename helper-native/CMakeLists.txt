cmake_minimum_required(VERSION 3.24)

project(fuke_helper_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(ixwebsocket CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(fuke-helper WIN32
    main.cpp
    websocket_client.cpp
    websocket_client.h
    process_launcher.cpp
    process_launcher.h
    shell_executor.cpp
    shell_executor.h
    privilege.cpp
    privilege.h
    protocol.cpp
    protocol.h
)

target_compile_definitions(fuke-helper PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0601
)

target_link_libraries(fuke-helper PRIVATE
    ixwebsocket::ixwebsocket
    nlohmann_json::nlohmann_json
    ws2_32
    advapi32
    bcrypt
    userenv
    shell32
    wtsapi32
)
