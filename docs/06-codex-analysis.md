# Codex 分析汇总

## PDD 版本匹配分析

Codex 分析了 fuke 的版本管理机制：
- 系统上有 PDD 3.5.7.16 完整安装（`%LOCALAPPDATA%\huihui\pdd\3.5.7.16\`）
- 原 fuke 配置 `config.ini` 锁定 `pdd=3.5.7.16`
- 匹配的 DLL: `PddExtend-3.5.7.16.dll` (1.2MB)
- PDD 3.6.7.6 无匹配 DLL，必须降级

Codex 确认的 DLL 来源：
- 所有 DLL 来自原 fuke 安装包 `D:\Program Files\fuke\assets\inject\`
- 直接引用，无修改
- MD5: PddExtend-3.5.7.16.dll = 0329B3D3C9EC75642FB21EE114C2B992

## DLL 分离架构分析

Codex 通过字符串提取发现 DLL 分为两个独立组件：

### FULL DLL (PddExtend-3.5.7.16.dll, 1.2MB)
包含：
- ixwebsocket 客户端（连接 /publicplatform）
- JSON 解析 (JsonCpp)
- PublicPlatform API 命令（Connect, OneClickLogin, LoggedInAccounts）
- PeekNamedPipe（从 `qingyuai_hook` 管道读取）
- PDD 函数 Hook 引用（ExecJavascriptInternal, InsertMsg, SendTextMsg）
- 环境变量读取（JS_URL, JS_DATA, USE_DEVTOOL）

### STUB DLL (PddExtend-3.5.7.16.dll.stub, 139KB)
包含：
- WS2_32 send/recv Hook 安装
- 命名管道 `\\.\pipe\qingyuai_hook` 创建
- LoadLibraryA/GetProcAddress（加载系统库）
- 不含任何 WebSocket 客户端代码
- 不含 PddExtend 路径引用（不会自动加载 FULL DLL）

### 发现的问题
两个 DLL 需同时注入同一进程才能完整工作：
- STUB → Hook WS2_32 → 创建管道
- FULL DALL → 读管道 → WebSocket 转发

但 fuke-helper 的 `launch_platform` 只接受一个 `inject_dllpath` 参数，
因此单独注入任一个都无法实现完整功能。
原 fuke 可能通过其他机制（如 fuke-helper 内部逻辑或额外配置）
实现了双 DLL 注入。

## 安全性分析

Codex 发现 PDD 3.5.7.16 自带完整性检查：
- `StartConsistencyCheck`、`FileHashCheck` 等代码
- `--remote-debugging-port=19999` 会触发"程序不完整"弹窗
- 删除/修改 PDDUpdate.exe 可能触发更新提示
- 建议保留 PDDUpdate.exe 原版或使用重命名策略
