/**
 * Hook CreateProcessInternalW 实现
 *
 * 复刻 PddExtend-3.5.7.16.dll 的做法：
 *   当 PDD 创建 pddwebworkbench.exe 子进程（CEF browser 进程）时，
 *   在命令行追加：
 *     --disable-web-security --remote-debugging-port=XXXX
 *
 * 为什么 Hook CreateProcessInternalW 而不是 CreateProcessW？
 *   CreateProcessW 内部调用 CreateProcessInternalW，
 *   Hook 更底层的 CreateProcessInternalW 可以覆盖所有进程创建路径。
 */

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "hook_createprocess.h"
#include "dllmain.h"
#include "MinHook.h"

// 原始函数指针
typedef BOOL (WINAPI *PFN_CreateProcessInternalW)(
    HANDLE hToken,
    LPCWSTR lpApplicationName,
    LPWSTR lpCommandLine,
    LPSECURITY_ATTRIBUTES lpProcessAttributes,
    LPSECURITY_ATTRIBUTES lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCWSTR lpCurrentDirectory,
    LPSTARTUPINFOW lpStartupInfo,
    LPPROCESS_INFORMATION lpProcessInformation,
    PHANDLE hRestrictedUser
);

static PFN_CreateProcessInternalW g_OriginalCreateProcessInternalW = nullptr;

// 追加的命令行参数模板
// 注意：与 PddExtend-3.5.7.16.dll 一致，
//       同时追加 --disable-web-security 和 --remote-debugging-port
#define APPEND_ARGS_FMT L" --disable-web-security --remote-debugging-port=%d"

// 目标进程名（小写比较）
#define TARGET_PROCESS L"pddwebworkbench.exe"

/**
 * 检查 lpApplicationName 或 lpCommandLine 是否指向目标进程
 */
static BOOL IsTargetProcess(LPCWSTR lpApplicationName, LPCWSTR lpCommandLine)
{
    // 检查 ApplicationName（通常是完整路径）
    if (lpApplicationName)
    {
        size_t len = wcslen(lpApplicationName);
        size_t targetLen = wcslen(TARGET_PROCESS);

        if (len >= targetLen)
        {
            // 比较最后 targetLen 个字符（忽略大小写）
            if (_wcsicmp(lpApplicationName + len - targetLen, TARGET_PROCESS) == 0)
                return TRUE;
        }
    }

    // 检查 CommandLine（可能是 "pddwebworkbench.exe" 或完整路径）
    if (lpCommandLine)
    {
        // 跳过可能的前导空格和引号
        while (*lpCommandLine == L' ' || *lpCommandLine == L'"')
            lpCommandLine++;

        size_t len = wcslen(lpCommandLine);
        size_t targetLen = wcslen(TARGET_PROCESS);

        if (len >= targetLen)
        {
            // 检查是否以目标进程名开头
            if (_wcsnicmp(lpCommandLine, TARGET_PROCESS, targetLen) == 0)
                return TRUE;
        }

        // 也检查完整路径的情况（搜索子字符串）
        const WCHAR* found = wcsstr(lpCommandLine, TARGET_PROCESS);
        if (found)
        {
            // 确保找到的是完整文件名（前后是分隔符或字符串边界）
            // 简单判断：找到的位置 + targetLen 处是空格、引号或字符串结尾
            if (found == lpCommandLine ||
                found[-1] == L'\\' || found[-1] == L'/' || found[-1] == L'"')
            {
                return TRUE;
            }
        }
    }

    return FALSE;
}

/**
 * 构建新的命令行：原始命令行 + CDP 参数
 */
static LPWSTR BuildNewCommandLine(LPCWSTR originalCmdLine)
{
    // 构建追加参数
    WCHAR appendArgs[128];
    swprintf_s(appendArgs, APPEND_ARGS_FMT, g_state.devtool_port);

    size_t origLen = wcslen(originalCmdLine);
    size_t appendLen = wcslen(appendArgs);
    size_t totalLen = origLen + appendLen + 1;

    LPWSTR newCmdLine = (LPWSTR)HeapAlloc(
        GetProcessHeap(),
        HEAP_ZERO_MEMORY,
        totalLen * sizeof(WCHAR)
    );

    if (!newCmdLine)
        return nullptr;

    wcscpy_s(newCmdLine, totalLen, originalCmdLine);
    wcscat_s(newCmdLine, totalLen, appendArgs);

    return newCmdLine;
}

/**
 * Hook 函数：替换 CreateProcessInternalW
 */
static BOOL WINAPI Hooked_CreateProcessInternalW(
    HANDLE hToken,
    LPCWSTR lpApplicationName,
    LPWSTR lpCommandLine,
    LPSECURITY_ATTRIBUTES lpProcessAttributes,
    LPSECURITY_ATTRIBUTES lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCWSTR lpCurrentDirectory,
    LPSTARTUPINFOW lpStartupInfo,
    LPPROCESS_INFORMATION lpProcessInformation,
    PHANDLE hRestrictedUser)
{
    // 检查是否是目标进程
    if (IsTargetProcess(lpApplicationName, lpCommandLine))
    {
        OutputDebugStringW(L"[CdpEnabler] Intercepted pddwebworkbench.exe creation, injecting CDP args\n");

        // 构建新的命令行
        LPWSTR newCmdLine = BuildNewCommandLine(
            lpCommandLine ? lpCommandLine : lpApplicationName
        );

        if (newCmdLine)
        {
            OutputDebugStringW(L"[CdpEnabler] New command line: ");
            OutputDebugStringW(newCmdLine);
            OutputDebugStringW(L"\n");

            // 使用修改后的命令行调用原始函数
            BOOL result = g_OriginalCreateProcessInternalW(
                hToken,
                nullptr,              // lpApplicationName 置空，使用命令行
                newCmdLine,           // 修改后的命令行
                lpProcessAttributes,
                lpThreadAttributes,
                bInheritHandles,
                dwCreationFlags,
                lpEnvironment,
                lpCurrentDirectory,
                lpStartupInfo,
                lpProcessInformation,
                hRestrictedUser
            );

            HeapFree(GetProcessHeap(), 0, newCmdLine);
            return result;
        }
    }

    // 非目标进程，直接透传
    return g_OriginalCreateProcessInternalW(
        hToken,
        lpApplicationName,
        lpCommandLine,
        lpProcessAttributes,
        lpThreadAttributes,
        bInheritHandles,
        dwCreationFlags,
        lpEnvironment,
        lpCurrentDirectory,
        lpStartupInfo,
        lpProcessInformation,
        hRestrictedUser
    );
}

BOOL InstallCreateProcessHook()
{
    // 初始化 MinHook
    MH_STATUS status = MH_Initialize();
    if (status != MH_OK)
    {
        WCHAR msg[128];
        swprintf_s(msg, L"[CdpEnabler] MH_Initialize failed: %d\n", status);
        OutputDebugStringW(msg);
        return FALSE;
    }

    // 获取 kernel32.dll 中的 CreateProcessInternalW
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!hKernel32)
    {
        OutputDebugStringW(L"[CdpEnabler] Failed to get kernel32.dll handle\n");
        return FALSE;
    }

    LPVOID pTarget = GetProcAddress(hKernel32, "CreateProcessInternalW");
    if (!pTarget)
    {
        OutputDebugStringW(L"[CdpEnabler] CreateProcessInternalW not found in kernel32.dll\n");
        return FALSE;
    }

    // 创建 Hook
    status = MH_CreateHook(
        pTarget,
        Hooked_CreateProcessInternalW,
        (LPVOID*)&g_OriginalCreateProcessInternalW
    );

    if (status != MH_OK)
    {
        WCHAR msg[128];
        swprintf_s(msg, L"[CdpEnabler] MH_CreateHook failed: %d\n", status);
        OutputDebugStringW(msg);
        return FALSE;
    }

    // 启用 Hook
    status = MH_EnableHook(pTarget);
    if (status != MH_OK)
    {
        WCHAR msg[128];
        swprintf_s(msg, L"[CdpEnabler] MH_EnableHook failed: %d\n", status);
        OutputDebugStringW(msg);
        return FALSE;
    }

    OutputDebugStringW(L"[CdpEnabler] CreateProcessInternalW hook installed successfully\n");
    return TRUE;
}

void RemoveCreateProcessHook()
{
    MH_Uninitialize();
    OutputDebugStringW(L"[CdpEnabler] Hook removed\n");
}
