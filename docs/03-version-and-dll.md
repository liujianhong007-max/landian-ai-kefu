# PDD 版本与 DLL 匹配

## 版本匹配原则
DLL 通过 Hook PDD 内部 C++ 方法工作，不同版本间函数地址不同，必须精确匹配。

## 版本矩阵

| PDD 版本 | 匹配 DLL | 大小 | 状态 |
|----------|----------|------|------|
| 3.5.7.16 | PddExtend-3.5.7.16.dll | 1,264KB | 当前使用 |
| 3.5.7.16 | PddExtend-3.5.7.16.dll.stub | 139KB | STUB（仅 hook） |
| 3.6.3.6  | PddExtend-3.6.3.6.dll  | 1,014KB | 备用 |
| 3.4.0.x  | PddExtend-3.4.0.1x.dll | 1,214KB | 旧版 |

DLL 来源目录：`D:\Program Files\fuke\assets\inject\`

## DLL 架构（STUB + FULL 分离）

### FULL DLL (1.2MB)
- ixwebsocket WebSocket 客户端
- 读取环境变量 JS_URL/JS_DATA 确定连接地址
- PublicPlatform API 命令处理
- PeekNamedPipe 从管道读取 hook 数据
- PDD 函数 Hook（ExecJavascriptInternal, InsertMsg 等）

### STUB DLL (139KB)
- WS2_32 send/recv Hook
- 命名管道 `\\.\pipe\qingyuai_hook`
- 不含 WebSocket 客户端

### 当前已知问题
- 仅注入 FULL DLL → WS 连接正常，但消息 Hook 不触发
- 仅注入 STUB → 管道创建正常，但无 WS 连接
- STUB 内部无代码加载 FULL DLL，两个 DLL 需同时注入同一进程

## 版本切换命令
```powershell
# 复制 PDD 到项目
robocopy "$env:LOCALAPPDATA\huihui\pdd\3.5.7.16" "pdd-workbench" /MIR

# 检查 DLL 完整性（正常 > 500KB）
(Get-Item "path\to\PddExtend-3.x.x.x.dll").Length

# 修改 pdd-manager.js 第 17 行
const DEFAULT_DLL_PATH = 'D:\\...\\PddExtend-3.x.x.x.dll';
```
