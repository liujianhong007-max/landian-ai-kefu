# CdpEnabler.dll — 自研最小 CDP 启用 DLL

## 概述

复刻 `PddExtend-3.5.7.16.dll` 的 CDP 端口启用逻辑，**仅保留核心功能**：
Hook `CreateProcessInternalW`，当 PDD 创建 `pddwebworkbench.exe` 子进程（CEF browser 进程）时，
自动追加 `--disable-web-security --remote-debugging-port=19999` 命令行参数。

## 逆向依据

通过分析 `PddExtend-3.5.7.16.dll` 二进制，发现：

```
DLL 内硬编码字符串（UTF-16LE）：
  pddwebworkbench.exe --disable-web-security --remote-debugging-port=19999

DLL 内读取的环境变量：
  USE_DEVTOOL    - 是否启用 CDP（"1" 启用）
  DEVTOOL_PORT   - 自定义端口（可选，默认 19999）
  JS_URL / JS_DATA / DEBUG_MODE / WS_URL

DLL 内 Hook 的目标函数：
  CreateProcessW / CreateProcessInternalW  ← 拦截进程创建
  ExecJavascriptInternal                   ← 消息注入
  CWaiBao::SendTextMsg                     ← 消息发送
```

**核心逻辑**：`debug::Initialize` → Hook `CreateProcessInternalW` → 
检测到创建 `pddwebworkbench.exe` 子进程 → 追加 CDP 参数

## 自研 DLL vs 原版 DLL

| 功能 | 原版 PddExtend | 自研 CdpEnabler |
|------|:---:|:---:|
| 开启 CDP 调试端口 | ✅ | ✅ |
| WebSocket 客户端 | ✅ | ❌ |
| Bridge JS 注入 | ✅ | ❌ (走 CDP) |
| 消息 Hook/转发 | ✅ | ❌ (走 CDP) |
| 反注入保护 | ✅ | ❌ |
| DLL 大小 | ~1.2 MB | ~50 KB |
| 源码行数 | 未知 (闭源) | ~200 行 |

## 工作原理

```
1. helper 创建 PDD 进程 (CREATE_SUSPENDED)
   环境变量: USE_DEVTOOL=1, DEVTOOL_PORT=19999
   
2. helper 注入 CdpEnabler.dll (CreateRemoteThread + LoadLibrary)

3. DllMain(DLL_PROCESS_ATTACH):
   ├── 读取 USE_DEVTOOL → 如果 != "1" 则什么都不做
   ├── 读取 DEVTOOL_PORT → 默认 19999
   └── InstallCreateProcessHook()
       └── MinHook Hook CreateProcessInternalW

4. ResumeThread → PDD 正常启动

5. PDD 内部创建 pddwebworkbench.exe 子进程时:
   ├── 触发 Hooked_CreateProcessInternalW
   ├── 检测到目标进程名 "pddwebworkbench.exe"
   ├── 原始命令行: pddwebworkbench.exe --type=browser ...
   ├── 修改后命令行: pddwebworkbench.exe --type=browser ... --disable-web-security --remote-debugging-port=19999
   └── 调用原始 CreateProcessInternalW

6. CDP 端口 19999 在子进程中打开 → cdp-manager.js 可连接
```

## 编译

### 前置条件

- Visual Studio 2022（含"使用 C++ 的桌面开发" workload）
- CMake 3.16+

### 编译步骤

```bat
cd helper-native\custom-dll
build.bat          # Release x64
build.bat debug    # Debug x64
```

输出文件：`assets\inject\CdpEnabler.dll`

### 手动编译

```bat
cd helper-native\custom-dll
mkdir build && cd build
cmake .. -G "Visual Studio 17 2022" -A x64
cmake --build . --config Release
```

## 使用方式

替换 `main/pdd-manager.js` 中的 DLL 路径：

```js
// 原来
inject_dllpath: "PddExtend-3.5.7.16.dll"

// 改为
inject_dllpath: "CdpEnabler.dll"
```

环境变量保持不变（`helper-native/process_launcher.cpp` 已设置）：

```
USE_DEVTOOL=1        ← 必需，触发 CDP 启用
DEVTOOL_PORT=19999   ← 可选，自定义端口
```

## 注意事项

1. **必须挂起创建 + 注入 + 恢复**：DLL 必须在 PDD 主进程的 CEF 初始化之前注入，
   否则无法 Hook 到子进程的创建调用。

2. **仅 x64**：PDD 工作台是 64 位进程，此 DLL 也是 x64。

3. **依赖 MinHook**：编译时静态链接 MinHook（MIT 协议），无需额外运行时依赖。

4. **无副作用**：如果 `USE_DEVTOOL` 环境变量不为 `"1"`，DLL 不安装任何 Hook，
   对 PDD 进程零影响。

## 项目结构

```
helper-native/custom-dll/
├── CMakeLists.txt          # CMake 构建配置
├── build.bat               # 一键编译脚本
├── README.md               # 本文件
├── minhook/                # MinHook v1.3.4 源码 (MIT)
│   ├── include/MinHook.h
│   └── src/
├── src/
│   ├── dllmain.h           # 全局状态定义
│   ├── dllmain.cpp         # DllMain 入口
│   ├── hook_createprocess.h
│   └── hook_createprocess.cpp  # CreateProcessInternalW Hook
└── build/                  # CMake 构建输出
```
