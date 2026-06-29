/**
 * CdpEnabler.dll - 自研最小 CDP 启用 DLL
 *
 * 功能：在 DllMain 中读取 USE_DEVTOOL 和 DEVTOOL_PORT 环境变量，
 *       如果 USE_DEVTOOL=1，则 Hook CreateProcessInternalW，
 *       当 PDD 创建 pddwebworkbench.exe 子进程时，
 *       自动追加 --remote-debugging-port=XXXX 命令行参数。
 *
 * 复刻自 PddExtend-3.5.7.16.dll 的 debug::Initialize 逻辑。
 */

#include <stdlib.h>
#include <stdio.h>
#include "dllmain.h"
#include "hook_createprocess.h"

GlobalState g_state;

BOOL APIENTRY DllMain(HINSTANCE hModule, DWORD dwReason, LPVOID /*lpReserved*/)
{
    if (dwReason == DLL_PROCESS_ATTACH)
    {
        // 禁用 DLL_THREAD_ATTACH/DETACH 通知以减少开销
        DisableThreadLibraryCalls(hModule);

        g_state.hModule = hModule;

        // 1. 读取 USE_DEVTOOL 环境变量
        WCHAR buf[32] = {0};
        DWORD len = GetEnvironmentVariableW(L"USE_DEVTOOL", buf, 32);

        if (len == 0 || len >= 32)
        {
            // 环境变量不存在或过长，不启用 CDP
            return TRUE;
        }

        if (wcscmp(buf, L"1") != 0)
        {
            // USE_DEVTOOL 不为 "1"，不启用
            return TRUE;
        }

        g_state.devtool_enabled = true;

        // 2. 读取 DEVTOOL_PORT（可选，默认 19999）
        WCHAR portBuf[16] = {0};
        DWORD portLen = GetEnvironmentVariableW(L"DEVTOOL_PORT", portBuf, 16);
        if (portLen > 0 && portLen < 16)
        {
            int port = (int)wcstol(portBuf, nullptr, 10);
            if (port > 0 && port < 65536)
            {
                g_state.devtool_port = port;
            }
        }

        // 3. 安装 Hook
        InstallCreateProcessHook();

        OutputDebugStringW(L"[CdpEnabler] DLL loaded, CDP port: ");
        WCHAR debugMsg[64];
        swprintf_s(debugMsg, L"%d\n", g_state.devtool_port);
        OutputDebugStringW(debugMsg);
    }
    else if (dwReason == DLL_PROCESS_DETACH)
    {
        // 卸载 Hook（进程退出时）
        RemoveCreateProcessHook();
    }

    return TRUE;
}
