# pdd-fuke 架构总览

## 项目简介
pdd-fuke 是基于 Electron 的 PDD 商家客服消息聚合工具。通过集成 fuke-helper 启动 PDD 工作台并注入扩展模块，实现消息的捕获和转发。

## 核心链路
```
Renderer UI (Vue)
  ↓ IPC
Main Process (Electron)
  ├── WsServer (:random/publicplatform) ← DLL 回连
  ├── HttpBridge (:random+1/pdd-bridge.js)
  └── PddManager
       └── HelperClient (WS RPC)
            └── fuke-helper.exe
                 └── launch_platform → PddWorkbench.exe + DLL 注入
```

## 目录结构
```
pdd-fuke/
├── main/                   # Electron 主进程
│   ├── index.js            # 入口组装：窗口、IPC、服务装配
│   ├── chat-handlers.js    # 启动/发送/自动回复/转人工编排
│   ├── pdd-observers.js    # 状态监听、bridge health、WBChat 观察
│   ├── pdd-bridge-runtime.js # PDD bridge 脚本与 HTTP bridge 服务
│   ├── pdd-manager.js      # PDD 生命周期管理 + HelperClient
│   ├── qn-manager.js       # 千牛生命周期管理
│   ├── websocket.js        # /publicplatform WS 服务端
│   ├── dll-injector.js     # Win32 DLL 注入 (koffi)
│   ├── message-parser.js   # 消息协议解析 (9 种类型)
│   ├── cdp-manager.js      # CDP 连接与端口扫描
│   ├── win32-helper.js     # Windows 窗口枚举
│   ├── wbchat-watcher.js   # 本地聊天库文件变化监听
│   ├── ai-settings-store.js # AI 设置本地存储
│   ├── diagnostics-snapshot.js # 诊断快照汇总
│   └── logger.js           # 文件日志
├── pdd-workbench/          # PDD 工作台 (3.5.7.16)
├── renderer/               # 前端 UI
├── test/                   # 测试 (8 个模块)
├── preload/                # Electron preload
├── docs/                   # 开发文档
└── package.json
```

## 当前拆分原则

- 入口文件只保留组装职责。`main/index.js` 负责应用启动、依赖装配、IPC 注册，不继续堆积平台业务细节。
- 当前代码已经按这个原则完成第一轮落地：`index.js` 不再承载 bridge script、自动回复实现、bridge 观察细节本体。
- bridge 相关逻辑至少分成三层：
  1. bridge runtime：脚本生成、socket 连接、命令下发；
  2. bridge diagnostics：探针、beacon、调试事件；
  3. bridge actions：发送消息、转接客服、会话切换。
- 对外导出的工厂函数默认保持“测试隔离优先”：
  - 默认 logger 不写真实磁盘；
  - 默认 store 不复用进程级单例；
  - 只有应用运行时装配层才显式注入共享实例。
- 浮窗状态和主链路状态使用同一套平台归一化规则；`publicplatform` 在业务语义上等同于 PDD，不允许各文件自己发明判断。
- 任何会重复注入到页面的脚本，都不能把关键运行时对象只保存在局部闭包里；必须通过全局可替换引用读取当前活动连接。

这条拆分原则不是代码洁癖，是为了减少“加一个诊断功能，把收发主链路顺手改死”的连带 bug。

## 技术栈
- Electron 31.7.7
- Node.js 18+
- koffi (Win32 FFI)
- ws (WebSocket)
- win32-api (Windows API 封装)
- fuke-helper.exe (第三方启动注入工具)
- PddExtend-3.5.7.16.dll (第三方扩展模块)
