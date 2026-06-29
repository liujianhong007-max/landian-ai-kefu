# fuke-helper 通信协议

## 通信模型
- Electron 启动 WebSocket Server (默认 port 5555, path `/Extend`)
- fuke-helper.exe 作为客户端连接
- 请求-响应模式，FIFO 顺序处理

## 协议格式

### Hello 事件 (helper → electron)
```json
{"type":"event","body":{"name":"hello","param":{"platform":"fuke-helper","version":"1.0.0"}}}
```

### Invoke 请求 (electron → helper)
```json
{"type":"invoke","id":"1","body":{"name":"execute_shell","param":{"command":"taskkill /F /IM PddWorkbench.exe"}}}
```

### Response 响应 (helper → electron)
```json
{"type":"response","body":{"data":{"exit_code":0,"output":"..."},"id":null,"message":"","success":true}}
```

## 关键注意事项
- 响应**没有顶层 id 字段**，id 在 body 内且为 null
- 匹配条件：`frame.type === 'response' && frame.body?.success !== undefined`
- 本项目使用 **FIFO 队列** 匹配（非 id 匹配）

## 支持的方法

| 方法 | 参数 | 返回 |
|------|------|------|
| execute_shell | {command: string} | {exit_code, output} |
| launch_platform | {exe_path, inject_dllpath, use_devtool, ws_url, js_url, js_data} | {pid} |

## launch_platform 参数详解
```
exe_path       → PddWorkbench.exe 绝对路径
inject_dllpath → 要注入的 DLL 绝对路径
use_devtool    → 1=启用, 0=禁用
ws_url         → DLL 回连的 WebSocket 地址
js_url         → bridge.js 的 HTTP 地址
js_data        → WebSocket 端口号
```

## 启动时序
```
1. [用户点击 Launch]
2. helper 连接 → hello 握手
3. execute_shell: taskkill (清理旧进程)
4. launch_platform: 启动 PDD + 注入 DLL
5. PDD 运行 → DLL 回连 /publicplatform
```
