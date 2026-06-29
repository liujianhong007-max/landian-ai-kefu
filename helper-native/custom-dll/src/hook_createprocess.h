#pragma once

#include <windows.h>

/**
 * 安装 CreateProcessInternalW Hook。
 * 必须在 DllMain DLL_PROCESS_ATTACH 中调用。
 * 返回 TRUE 表示安装成功。
 */
BOOL InstallCreateProcessHook();

/**
 * 卸载 Hook。
 * 在 DLL_PROCESS_DETACH 中调用。
 */
void RemoveCreateProcessHook();
