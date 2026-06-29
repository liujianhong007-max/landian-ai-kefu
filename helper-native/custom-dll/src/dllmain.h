#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

// 默认 CDP 调试端口
#define DEFAULT_CDP_PORT 19999

// 全局状态
struct GlobalState {
    bool devtool_enabled = false;
    int  devtool_port   = DEFAULT_CDP_PORT;
    HINSTANCE hModule   = nullptr;
};

extern GlobalState g_state;
