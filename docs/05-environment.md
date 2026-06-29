# 环境配置与命令速查

## 系统环境
- OS: Windows 10 x64
- Node.js: v18+
- 项目路径: `C:\Users\26799\Desktop\pdd-fuke`

## 依赖组件路径
| 组件 | 路径 |
|------|------|
| PDD 工作台 | `pdd-workbench/PddWorkbench.exe` (3.5.7.16) |
| DLL (FULL) | `D:\Program Files\fuke\assets\inject\PddExtend-3.5.7.16.dll` |
| DLL (STUB) | `D:\Program Files\fuke\assets\inject\PddExtend-3.5.7.16.dll.stub` |
| fuke-helper | `D:\Program Files\fuke\assets\inject\fuke-helper.exe` |
| Electron | `node_modules/electron/dist/electron.exe` (31.7.7) |
| 日志目录 | `%LOCALAPPDATA%\pdd-fuke\logs\` |

## 开发命令
```powershell
# 启动
$env:PDD_WORKBENCH_EXE = "C:\Users\26799\Desktop\pdd-fuke\pdd-workbench\PddWorkbench.exe"
Start-Process ".\node_modules\electron\dist\electron.exe" "." -WorkingDirectory "C:\Users\26799\Desktop\pdd-fuke"

# 测试
npm test                                              # 全量
npm test -- test/test-helper-integration.js           # 指定文件

# 日志
Get-Content "$env:LOCALAPPDATA\pdd-fuke\logs\main.log" -Tail 30

# 清理
taskkill /F /IM PddWorkbench.exe
Get-Process -Name "electron" | Stop-Process -Force

# 直接测试 helper 协议
node -e "
const {WebSocket, WebSocketServer} = require('./node_modules/ws');
const {spawn} = require('child_process');
const srv = new WebSocketServer({host:'127.0.0.1',port:5556,path:'/Extend'});
srv.on('connection', ws => {
  ws.on('message', d => console.log('RECV:', d.toString()));
  ws.send(JSON.stringify({type:'invoke',id:'1',body:{name:'execute_shell',param:{command:'cmd /c echo OK'}}}));
});
srv.on('listening', () => spawn('D:/Program Files/fuke/assets/inject/fuke-helper.exe', ['ws://127.0.0.1:5556/Extend']));
setTimeout(() => process.exit(0), 5000);
"

# 验证 DLL 是否被替换为 stub
$dll = "D:\Program Files\fuke\assets\inject\PddExtend-3.5.7.16.dll"
(Get-Item $dll).Length   # 正常 > 500KB, stub < 200KB
```

## 启动验证 Checklist
日志 `%LOCALAPPDATA%\pdd-fuke\logs\main.log`:
- [ ] `[ws:start]` — WS 服务启动
- [ ] `[helper:hello]` — fuke-helper 握手
- [ ] `[helper:invoke-response]` x2 — taskkill + launch_platform
- [ ] `[ws:client-connected]` — DLL 已连接
- [ ] `[ws:message-received]` — 消息开始流入
