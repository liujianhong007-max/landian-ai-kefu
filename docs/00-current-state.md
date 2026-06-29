## 2026-06-23 native helper 最新结论

- 用户提供的 `D:\majiang\fuke_helper\fuke_helper_native` 已复制到 `helper-native` 并编译成功，产物为 `helper-native\build\Release\fuke-helper.exe`。
- 编译依赖通过本地 `C:\tmp\vcpkg` 安装；因 vcpkg 内部下载失败，已手动缓存 PowerShell Core、7zip、ninja、mbedtls、zlib、ixwebsocket、nlohmann-json，并在本地 port 中跳过 pkgconfig fixup。
- `helper-native` 运行需要同目录 `z.dll`，已从 `helper-native\vcpkg_installed\x64-windows\bin\z.dll` 复制到 Release 目录。
- 已新增临时验证脚本 `tools/launch-qn-native-helper.js`，用于用 native helper 启动千牛并保持 helper 存活。
- native helper 不带提权环境时为 Medium/Limited；已在验证脚本中设置 `PDD_FUKE_HELPER_ELEVATE=1`，重启后 native helper 为 High/Full，主 `AliWorkbench.exe` 为 Medium/Limited，并已加载 `QnExtend-9.63.20.dll`。
- 真实验证中，客服工作台会再拉起子 `AliWorkbench.exe --bc=1`；主进程有 `QnExtend`，子进程没有，并且启动台没有收到新的 QN WebSocket 回连。
- 手动向子 `AliWorkbench.exe` 补注入 `QnExtend-9.63.20.dll` 时，增强后的 JS 注入器确认 `LoadLibraryW returned 0`，所以“事后补注入子进程”不可行。
- 当前结论：native helper 源码版可以完成主进程启动和主进程 DLL 注入，但仍未还原福客 helper 对千牛客服工作台的完整生效路径；差异继续压在更早的进程创建/注入时机/隐藏初始化动作，而不是 JS 发送命令。
## 2026-06-23 QN send-button locator

- `fuke-qn-hh-4.3.js` 已加入千牛发送按钮定位探针：页面加载后会扫描可见的“发送”候选按钮，并上报 `send-button-scan`，包含 DOM 标签、class、文本和 `getBoundingClientRect()` 坐标。
- 当前 DOM 发送路线已改为 `locate-only`：只返回输入框和发送按钮位置，不点击、不回车、不真正发送。
- 千牛自动回复 payload 已补充 `ccode`，后续如果继续测试 native `send_text_message`，可以直接使用完整会话 id。
- 已新增 Win32 窗口层诊断工具：`tools/window-diagnostics/WindowDiagnostics.cs`，构建命令 `npm run build:window-diagnostics`，运行命令 `npm run diagnose:window`。
- 2026-06-23 15:50 实测鼠标点下方窗口为主 `AliWorkbench.exe` 的 `Qt5152QWindowIcon` 顶层窗口，标题“宏哄哄-接待中心”，没有独立发送按钮 HWND；因此后续鼠标路线应按窗口坐标/屏幕坐标/截图层定位，而不是继续期待 DOM 或 Win32 子控件能直接暴露发送按钮。
- 已新增最小鼠标点击工具：`tools/mouse-click/MouseClick.cs`，构建命令 `npm run build:mouse-click`，当前验证命令 `npm run click:qn-send`。
- 2026-06-23 15:56 实测：在千牛输入框已有文本时，`click:qn-send` 点击 `接待中心` 窗口 client 坐标 `(796,773)`，日志收到新的 QN `direction: 'assistant'` 消息，内容“要发货了哦”。结论：Win32 `SendInput` 鼠标点击发送按钮路线已跑通；下一步是把固定坐标改成按窗口尺寸/按钮定位动态计算。
- 已新增最小回车工具：`tools/key-press/KeyPress.cs`，构建命令 `npm run build:key-press`，验证命令 `npm run press:qn-enter`。
- 2026-06-23 16:00 实测：在千牛输入框已有文本时，`press:qn-enter` 对 `接待中心` 窗口发送真实 Enter，日志收到新的 QN `direction: 'assistant'` 消息，内容“还在吗亲亲”。结论：真实键盘 Enter 发送路线也跑通；优先级上 Enter 比鼠标点击更不受按钮坐标影响，但仍要求输入框/会话处于正确状态。

# 当前状态交接

更新时间：2026-06-23

## 当前节奏

先完成框架和核心链路，细节最后优化。

每次对话结束后，如果项目状态、关键判断、启动方式、已验证链路或后置优化点发生变化，需要同步更新本文档；没有实质变化则不更新，避免变成流水账。

项目内中文文档、日志、配置、脚本输出统一按 UTF-8 处理。PowerShell 读写中文文件时必须显式加 `-Encoding UTF8`；Node 文件读写必须显式使用 `'utf8'`。

当前优先级：
1. 启动台
2. 悬浮插件
3. PDD 实时收消息
4. 自动发送/自动回复
5. 日志和诊断
6. 千牛等平台扩展

## 已跑通的核心链路

PDD 当前已验证链路：

```text
Electron 启动台
  -> C# helper
  -> 启动 PddWorkbench
  -> 注入 PddExtend-3.5.7.16.dll
  -> DLL/页面 Bridge 回连本地 WebSocket /publicplatform
  -> main/websocket.js 解析消息
  -> main/index.js 自动回复（可接 tmagent）
  -> Bridge 发回 PDD 客户端
```

已验证：
- 买家消息可以实时收到。
- 商家端自动回复可以发送出去。
- 商家端发送回执可以收到。
- PDD 这条链路核心不是 CDP，而是 helper + DLL + Bridge WebSocket。

## 运行日志

主日志文件：

```text
%LOCALAPPDATA%\pdd-fuke\logs\main.log
```

常看关键词：
- `[app:start]`
- `[helper:start]`
- `[helper:hello]`
- `[pdd:launch-params]`
- `[ws:listening]`
- `[ws:client-connected]`
- `[ws:pdd-message-parsed]`
- `[chat:send-native-result]`
- `[auto-reply:sent]`
- `[auto-reply:tmagent-error]`
- `[auto-reply:handoff]`
- `[bridge:diagnostic]`

启动台 Diagnostics 区已经新增“刷新监控/复制快照”：
- 快照来自 `main/diagnostics-snapshot.js`。
- 会读取主日志尾部的最近发送回执，并运行 `tools/process-diagnostics/bin/ProcessDiagnostics.exe` 汇总 helper、`AliWorkbench.exe`、`AliRender.exe` 的父进程、token、integrity、elevation 信息。
- 该面板用于快速对比福客 helper 与 C# helper 启动出的千牛进程差异，减少手动翻日志。

## 启动方式

开发启动：

```powershell
$env:PDD_FUKE_USE_CSHARP_HELPER='1'
npm.cmd start
```

如果 helper 需要管理员权限，会弹 UAC。需要点“是”。

tmagent 自动回复接入：

```powershell
$env:PDD_FUKE_TMAGENT_BASE_URL='http://xingqiao.taluo.club'
$env:PDD_FUKE_TMAGENT_SHOP_ID='<shop id>'
$env:PDD_FUKE_TMAGENT_SHOP_NAME='<shop name>'
```

代码里暂时内置了默认 tmagent API key；也可以用 `PDD_FUKE_TMAGENT_API_KEY` 覆盖。每条 PDD 买家文本消息调用 `/api/orchestrate/chat`，收到 `action:"human_takeover"` 时不自动发送 AI 文案，只记录转人工日志。

## 当前关键判断

- helper 是通用启动器，主要负责连接 `/Extend`、执行命令、启动平台、启动前注入 DLL。
- DLL 是平台和版本适配层，PDD 版本变化会导致 DLL 需要重新适配。
- `PddExtend-3.5.7.16.dll` 对应当前 PDD 3.5.7.16。
- 千牛走同一条 helper + DLL 路线，但必须使用千牛 DLL：`QnExtend-9.63.20.dll` 或 `QnExtend-9.95.00.dll`。
- 福客千牛启动参数已确认：`AliWorkbench.exe` + `QnExtend-${version}.dll` + `user_power: true` + `use_devtool: true` + `js_url/js_data`，不需要额外 `exe_param`。
- 不要把“抑制更新”混到 helper 启动流程里。
- 不要在启动流程里删除或重命名 `PDDUpdate.exe`，之前会触发“程序文件不完整”弹窗。

## 千牛当前状态

已新增千牛框架接入：

- `main/qn-manager.js`
- `qn:launch` IPC
- 启动台“千牛”按钮和运行状态显示
- 千牛状态监控：`AliWorkbench.exe`
- 默认千牛 DLL：`D:\Program Files\fuke\assets\inject\QnExtend-9.95.00.dll`
- 如果千牛路径里能识别版本号，例如 `...\huihui\qn\9.63.20\AliWorkbench.exe`，会自动使用 `QnExtend-9.63.20.dll`
- 本机已发现运行中的千牛路径：`C:\Users\26799\AppData\Local\huihui\qn\9.63.20\AliWorkbench.exe`
- 已下载并纳入本地服务的千牛桥接脚本：`fuke-qn-hh-4.3.js`
- `startPddBridgeServer()` 会同时服务：
  - `/pdd-bridge.js`
  - `/qn-hh-4.3.js`

已验证：
- C# helper 可以启动千牛，并按版本传入 `QnExtend-9.63.20.dll`。
- 原福客 `fuke-helper.exe` 也可以启动千牛。
- 两种 helper 都能把 `js_url/js_data/ws_url/use_devtool/user_power` 参数传给 `launch_platform`。
- 千牛会请求 `/qn-hh-4.3.js`，并回连本地 WebSocket，平台识别为 `qn`。
- 已拿到千牛连接信息：`csrName`、`targetId`、千牛 UA。
- 千牛启动前必须清理 `AliWorkbench.exe` 和 `AliRender.exe`，否则可能出现 helper 返回成功但 DLL/脚本不生效。
- 自动化测试已覆盖 QN manager、桥接脚本服务、QN parser、PDD 现有链路。

尚未跑通：
- 千牛真实买家消息触发 `message/newMsg` 后的接收链路还需要实测。
- 千牛自动发送/自动回复还没有验证。

当前判断：
- 千牛不是 CDP 路线，仍然是 helper + QnExtend DLL + `qn-hh-4.3.js` + WebSocket。
- 之前不回连有旧进程/`AliRender.exe` 残留因素；但发送失败的根本差异已定位到 C# helper 未按 `user_power` 使用当前桌面用户 token 启动目标进程。
- 千牛非聊天事件，例如 `conv_change`、`userOrders`，不能按 PDD 消息解析；只有 `message/newMsg` 才进入聊天消息流。

## 已知后置优化

这些先不阻塞框架：

- 悬浮插件 UI 同步细节。
- PDD 页面上 CDP 状态显示，后续可以隐藏或弱化。
- 原始消息 `raw` 字段完整落日志，方便后续扩字段。
- 订单卡、商品卡字段增强。
- 右侧订单面板 DOM/API 结构化采集。
- 买家画像：最近咨询、最近订单、退款状态、待回复状态。
- 自研 DLL 最后做。
- helper 先用 C# 版本继续推进，稳定后再打包成正式 exe。
- 千牛真实客户端回连后，再补千牛消息 parser 和发送命令格式。

## 新会话优先阅读

新 Codex 会话先看：

1. `docs/00-current-state.md`
2. `main/index.js`
3. `main/pdd-manager.js`
4. `main/websocket.js`
5. `main/message-parser.js`
6. `helper-csharp/src/Program.cs`
7. `main/qn-manager.js`

## 2026-06-23 千牛实测补充

- 千牛通过 `QnExtend-9.63.20.dll` 启动后，已经确认会请求 `/qn-hh-4.3.js` 并连接本地 WebSocket。
- 最新实测中 `AliWorkbench.exe` 和多个 `AliRender.exe` 保持运行，说明千牛本次不是启动后立即崩溃。
- 千牛 WebSocket 当前会持续发送 `msgpack` 包，但还未被解析成 `message/newMsg` 聊天消息。
- `main/websocket.js` 已增强日志：未解析的 `msgpack` 会记录解码后的 `sample`，方便下一次实测直接看包结构。
- 该日志增强需要重启启动台后才会生效。
- 千牛 helper 选择逻辑已调整：千牛默认使用我们的 `helper-csharp\bin\PddFukeHelper.exe`；可用 `QN_CSHARP_HELPER_EXE` 指定新的 C# helper，也可用 `QN_FUKE_HELPER_EXE` 手动回退福客 helper。
- 买家号实测发送“你好”后，千牛返回 `type: 'message'` 的 msgpack 包，字段包含 `stableKey/msgid/messageId/fromid/fromidTargetId/loginid/loginidTargetId/toid/toidTargetId/msg.text/msgtime/svrtime/templateId/apiChatUri`。
- QN parser 已按 `fromidTargetId === loginidTargetId` 判断商家方向，否则为买家方向，避免 `selfState` 导致买家消息误判为 `assistant`。
- 出站文本命令已统一为 `{ act: 'sendtext', id, text }`。PDD bridge 会转换为 `socketUtil.sendMsg`；千牛 `qn-hh-4.3.js` 原生支持 `sendtext` 并调用内部 `j({ type: 'text', id, content })`。
- 千牛自动回复发送前会先发送 `{ act: 'switchConversation', id, customerName }` 激活买家会话；`sendtext` 会触发 `send_text_message` 并返回 `Failed`，因此千牛自动回复已改走 `{ act: 'sendMsg', param: { userid, msg } }`，对应千牛脚本里的 `intelligentservice.SendSmartTipMsg` 路线。
- 2026-06-23 实测：千牛买家消息已触发 `[auto-reply:sent]`，但当时走的是静态文案 `textSource: 'static'`，不是 tmagent；原因是自动回复只在显式设置 `PDD_FUKE_TMAGENT_API_KEY` 时才调用 tmagent。
- 已修复：自动回复默认使用 `tmagent-client.js` 内置默认 API key 调用 tmagent；可用 `PDD_FUKE_USE_TMAGENT=0` 关闭。
- 已修复：自动回复会跳过超过 5 分钟的旧消息回放，避免千牛打开会话后把历史消息逐条自动回复；可用 `PDD_FUKE_AUTO_REPLY_MAX_AGE_MS` 调整。
- 已验证 `switchConversation + sendtext` 仍失败，说明不是单纯当前会话未激活；已切到 `switchConversation + sendMsg`，日志不再出现 `send_text_message Failed`，但还需要从千牛界面确认 `SendSmartTipMsg` 是否真正展示为客服回复。
- 进一步对齐福客后，QN 启动参数已去掉 `ws_url`，自动回复改回福客同款 `sendtext`；实测仍返回 `send_text_message code=1 Failed`。随后已用福客原 `D:\Program Files\fuke\assets\inject\fuke-helper.exe` 启动 QN 做隔离测试，待新买家消息验证是否仍失败。
- 隔离测试已完成：使用福客原 `fuke-helper.exe` 启动同一 QN、同一 `QnExtend-9.63.20.dll`、同一 `qn-hh-4.3.js` 后，`sendtext` 成功，日志出现 `statusLabel=成功`，并收到商家方向 `newMsg`。结论：QN 发送失败根因在我们的 C# helper 启动/注入细节，不是 DLL、JS、tmagent、账号或千牛发送接口本身。当前已改回默认使用我们的 C# helper，下一步要做真实 QN 回归。
- 2026-06-23 重启后实测：tmagent 已走通，日志出现 `textSource: 'tmagent'`，生成了真实 AI 回复文本。
- C# helper 旧版启动的千牛发送失败，日志为 `nativeMethod=send_text_message`、`responseCode=1`、`responseMessage=Failed`，失败请求形如 `{"ccode":"2222657198225.1-1723106647.1#11001@cntaobao","text":"..."}`；福客原 helper 启动的千牛已成功发送。
- C# helper 已修复并覆盖正式 `helper-csharp\bin\PddFukeHelper.exe`：`user_power: true` 且 helper 已提权时，改为通过 `explorer.exe` 获取当前桌面用户 token，并走 `OpenProcessToken -> DuplicateTokenEx -> CreateProcessWithTokenW` 创建 suspended 目标进程后再注入 DLL。自动测试已通过，仍需真实 QN 发送回归确认。
- 进一步定位：福客 helper 自身日志在 `C:\Users\26799\AppData\Local\huihui\logs\Extend\fuke-launch.txt`，QN DLL 日志在同目录 `QNExtend_96320_log.txt*`。为对照黑盒行为，已新增 C# helper 诊断日志 `fuke-launch-csharp.txt`，并临时将千牛默认 helper 指向 `helper-csharp\bin\PddFukeHelper-debug.exe`，避免正式 `PddFukeHelper.exe` 被旧管理员进程锁住时无法覆盖。下一轮实测需看该日志里的 token/session/env/CreateProcess/InjectDll 分支。
- 2026-06-23 新实验：福客原 helper 成功样本里 helper 会在 launch 后断开退出；我们的 QN C# helper 已新增 `PDD_FUKE_HELPER_EXIT_AFTER_LAUNCH=1`，千牛默认启动会传该开关，`launch_platform` 成功响应后 helper 主动关闭 WebSocket 并退出。自动测试和 C# 编译已通过，启动台已重启到新版；仍需点击“启动千牛”后用买家号发新消息验证 `sendtext` 回执是否变为成功。
- 2026-06-23 回归结果：`PddFukeHelper-debug2.exe` 已确认提权后携带 `--exit-after-launch`，日志出现 `websocket=> exit after launch_platform response.`，helper 进程退出；但千牛 `sendtext` 仍返回 `nativeMethod=send_text_message`、`responseCode=1`、`statusLabel=失败`。因此“helper 常驻导致 QN 发送失败”已排除，下一步应继续对比福客 helper 与 C# helper 的进程创建属性/父子关系/命令行/启动环境差异，或临时回退福客 helper 保证产品链路推进。
- 同次实测：旧消息过滤生效，历史消息出现 `[auto-reply:skip] { reason: 'stale-message' }`，但一次消息事件里仍可能包含多条非过期 buyer text，需要继续收敛去重/只回复最新一条。
- 进一步修正判断：helper 是多平台共用的启动/注入容器，不能把 QN 发送失败当成 QN 专属发送命令问题继续改。平台差异应该在 DLL/JS/消息协议层；helper 层要还原的是通用启动不变量：目标进程父子关系、token/elevation/integrity、session、window station/desktop、current directory、环境变量、句柄继承和 suspended 注入/恢复顺序。
- 福客原 helper 成功样本里，`fuke-helper.exe` 在千牛运行期间保持存活，并且是主 `AliWorkbench.exe` 的父进程；我们的 `PddFukeHelper-debug2.exe --exit-after-launch` 样本中 helper 已退出，主 `AliWorkbench.exe` 的父进程已不存在，发送仍失败。已移除 QN 默认 `exitAfterLaunch` 实验开关，保留该能力只作为诊断工具。
- 下一步不要继续猜发送接口；应先做 helper 行为对照诊断，抓同一台机器上福客 helper 与 C# helper 启动出的千牛进程差异，重点看是否由“提权 helper + explorer token 代启动”造成 QN 原生发送校验失败。
- 已新增独立进程诊断工具：`tools/process-diagnostics/ProcessDiagnostics.cs`，构建命令 `npm run build:process-diagnostics`，运行命令 `npm run diagnose:processes`。当前快照确认福客 `fuke-helper.exe` 是 `user\26799`、session 1、`elevated=true`、High integrity，因此“福客 helper 没提权而我们提权”不是根因；下一轮必须在千牛实际运行时同时抓 `fuke-helper.exe`、`PddFukeHelper*.exe`、`AliWorkbench.exe`、`AliRender.exe` 的对照快照。
- 2026-06-23 对照诊断进一步收敛：福客 helper 与 C# helper 启动出的千牛在父子关系、session、token authId、elevationType、integrity 上一致。helper 都是 High/Full，`AliWorkbench.exe` 和 `AliRender.exe` 都是 Medium/Limited，authId 与 `explorer.exe` 一致。因此 token、登录会话、父子关系基本排除。
- 已测试 C# helper command line 尾空格假设：`PddFukeHelper-debug3.exe` 已按福客同款把空 `exe_param` 生成为 `"AliWorkbench.exe" `，但千牛 `send_text_message` 仍返回 `statusLabel=失败`、`responseCode=1`。该假设排除，当前改动只保留为对齐行为，不能视为修复。
- 同一环境切回福客原 helper 后，买家消息触发 tmagent 自动回复，日志出现 `statusLabel=成功`，并收到商家方向 `newMsg`。当前结论：差异已经压到更底层的注入实现或 helper 在注入前后的隐藏初始化动作；下一步重点比较 `CreateRemoteThread/LoadLibraryW` 注入细节、线程权限/等待方式、是否注入子进程或附加初始化，而不是继续改 QN JS/send 命令。

## 2026-06-23 千牛发送路线更新

- 新增进程诊断模块加载输出：`tools/process-diagnostics/ProcessDiagnostics.cs` 现在会在 `modules=` 行列出 `QnExtend`/`PddExtend`/`assets\inject` 相关模块，`main/diagnostics-snapshot.js` 会解析到 diagnostics 快照里。
- 最新 C# helper 实测：买家消息已触发 tmagent，`[auto-reply:sent] textSource: 'tmagent'` 出现，但千牛脚本走 `sendtext` 后仍返回 `nativeMethod=send_text_message`、`responseCode=1`、`statusLabel=失败`，所以界面没显示回复。
- 福客 helper 对照确认：福客和 C# helper 启动出的千牛都会出现主 `AliWorkbench.exe` 以及后续 `--bc=1` 子 `AliWorkbench.exe`，并非“子进程未注入 DLL”导致发送失败；继续盲目给子进程补注入不是正确方向。
- 为先跑通产品核心链路，千牛自动回复发送已从 `{ act: 'sendtext', id, text }` 改为 `{ act: 'sendMsg', param: { userid, msg } }`，对应 `qn-hh-4.3.js` 里的 `imsdk.invoke("intelligentservice.SendSmartTipMsg")` 路线，避开当前 C# helper 下失败的 native `send_text_message`。

## 2026-06-24 启动台 UI 整合

- 启动台已不再只做平台启动，`renderer/index.html` 内已整合右侧隐藏工具抽屉，默认关闭，点击“工具”后一键弹出四个工作区页签：`商品库`、`AI 客服设置`、`快捷回复`、`日志`。
- `商品库` 当前先用渲染层本地 mock 数据驱动，已具备平台筛选、店铺/商品搜索、客服筛选、批量学习、批量删除、单商品学习/删除等基础交互，目的是先把产品工作流和界面骨架定下来。
- `AI 客服设置` 已进启动台，当前先提供本地表单状态、保存动作和回复预览，不依赖主进程新接口；后续再把真实配置落盘和 tmagent 参数对接进去。
- 右侧诊断和会话面板仍保留原有链路：PDD/QN 状态、Bridge/CDP、日志快照、会话列表、手动发送都还在同一页面；工具抽屉弹出时覆盖在右侧。
- 已新增渲染层回归测试，覆盖“商品库初始渲染”“右侧工具抽屉默认关闭/点击打开”和“切换到 AI 设置页签”，防止后续改 UI 时把启动台工作区切坏。

## 2026-06-24 tmagent 设置面接入

- `AI 客服设置` 已按 tmagent 真实调用面改成接口配置视图，不再是泛化的 prompt/语气设置。
- 当前启动台本地保存字段为：`enabled`、`baseUrl`、`merchantName`、`tenantId`、`apiKey`，请求头固定映射为 `X-API-Key`。
- 本地存储实现已新增：
  - `main/ai-settings-store.js`
  - `ipcMain.handle('ai-settings:get')`
  - `ipcMain.handle('ai-settings:save')`
  - `preload/index.js` 暴露 `getAiSettings()` / `saveAiSettings()`
- 本地配置文件路径当前使用工作区内忽略文件：`config/ai-settings.local.json`，用于开发阶段保存租户配置，不写进源码常量。
- 启动台里已新增：
  - 请求头预览
  - `shop_id -> tenantId` 映射预览
  - `shop_name -> merchantName` 映射预览
  - `/api/orchestrate/chat` payload JSON 预览
- 当前已写入本地开发配置：
  - 商户名称：`疾风ai客服`
  - tenant_id：`9901d2b1-6abc-41d7-a41e-91501b794735`
  - 请求头：`X-API-Key: <local saved>`
- `createAutoReplyHandler()` 已接入这套本地设置。当前优先级顺序是：
  - 显式 `options.tmagent` / `options.useTmagent`
  - 本地 `config/ai-settings.local.json`
  - 环境变量 `PDD_FUKE_TMAGENT_*`
  - `tmagent-client.js` 内置默认值
- 当前映射关系已经生效：
  - `tenantId -> shop_id`
  - `merchantName -> shop_name`
  - `apiKey -> X-API-Key`
  - `baseUrl -> /api/orchestrate/chat` 请求地址前缀
- 2026-06-24：`tmagent-client.js` 内置默认 `X-API-Key` 已按当前提供的 `sk-HXY...Df4` 更新；环境变量和本地保存配置仍优先覆盖内置值。
- 自动化验证已通过：`node --test test\launch-error.test.js test\diagnostics-snapshot.test.js`，`node --check main\index.js`。
- 仍需真实界面回归：用默认 C# helper 启动千牛后，让买家号发一条新消息，确认界面是否出现 `sendMsg` 发送的客服回复。

## 2026-06-24 PDD bridge 重注入 bug 结论

- 本次“Diagnostics 显示 `1 client`，但浮窗仍显示未启动/等待连接，同时买家新消息不再触发自动回复”的根因，不是 C# helper 抽风，也不是 tmagent 异常，而是 `main/index.js:createPddBridgeScript()` 在新增诊断/转接探针逻辑后引入了重注入闭包问题。
- PDD 页面会重复加载 bridge 脚本。第一次注入时，native hook 已经安装完成；第二次注入时，新脚本创建了新的 WebSocket，并主动关闭了旧 socket。
- 但旧 hook 仍引用第一次注入闭包里的局部 `socket` 变量，没有重新绑定到当前活动 socket。结果是：
  - 探针还能看到页面事件和 native 事件；
  - `wbchat:file-change`、`pdd:dom-chat` 仍然有变化；
  - 但真正的买家业务消息没有再进入 `ws:pdd-message-parsed`，自动回复链路断掉。
- 同时还叠加了一个状态归一化问题：PDD bridge 的真实平台名是 `publicplatform`，而部分状态判断和 bridge health 统计只按 `pdd` 处理，导致浮窗出现“`1 client` 但仍显示未启动/等待连接”的假象。

本次修复：

- bridge 脚本发送消息/诊断时，不再依赖注入时闭包里的局部 `socket`，统一改为读取 `window.__pddFukeBridgeSocket` 当前活动 socket。
- 主进程和浮窗状态渲染统一把 `publicplatform` 归一化为 PDD 平台处理。

以后必须遵守的规避规则：

1. 只要页面注入脚本可能重复执行，hook 内部禁止绑定局部 socket / 局部连接对象，必须走全局可替换引用。
2. 平台标识只能有一套归一化规则。`publicplatform` 和 `pdd` 这种别名不能在不同模块里各自判断。
3. 给 bridge 增功能时，必须额外验证“二次注入后买家消息是否还能进入 `ws:pdd-message-parsed`”，不能只看 Diagnostics 是否有 client。
4. `main/index.js` 继续堆 bridge、诊断、转接、自动回复、IPC，出连带 bug 的概率很高；后续应按功能拆分，至少把 bridge runtime、bridge diagnostics、auto-reply orchestration 从入口文件拆开。

## 2026-06-24 多 agent 收口结果

- 本轮按边界拆成三块并行做：
  - `P2.1` 千牛链路审计：只读，不改主链路代码。
  - `P2.2` 悬浮插件可用版：只改 `renderer/floating.*`、少量 `preload` 暴露和对应测试。
  - `P1.1` 日志可读性增强：只允许动日志格式和测试。
- 当前验收结论：
  - `P2.1` 通过。
  - `P2.2` 通过。
  - `P1.1` 未通过，已回退，不进入当前主线。

`P2.1` 千牛链路审计结论：

- 现在稳定的部分不是问题：
  - 启动/注入。
  - 脚本下发。
  - WebSocket 回连。
  - 基础状态监控。
- 当前不要优先动 `main/index.js` 猜业务逻辑。
- 如果下一轮只做一个最小补丁面，先看：
  1. `main/message-parser.js`
  2. `main/websocket.js`
- 千牛发送/接收排查时先盯这些日志：
  - 接收成功：`[ws:qn-message-parsed]`
  - 发送成功：bridge send callback 里的 `statusLabel=success` / `code=0`
  - 发送失败：`send_text_message Failed`、`responseCode=1`
  - 连接异常：`[ws:send-skip]`、`websocket closed`、`websocket error`

`P2.2` 悬浮插件当前已通过的能力：

- 已有独立悬浮窗，能跟随主工作台右侧定位。
- 能显示：
  - 当前平台与运行状态
  - CDP / 插件状态
  - 最近买家消息
  - 待回复数量
  - AI / 人工跟进状态
- 已支持两个本地动作：
  - `查看待回复`
  - `转人工 / 恢复 AI`
- 当前这些动作只影响悬浮窗本地状态，不改真实发送链路。这是刻意的，先把产品壳和工作流定住。

`P1.1` 日志可读性增强未通过原因：

- 目标是自动修复日志里的中文乱码并保留原文线索。
- 实测测试仍然红，不能稳定证明“乱码 -> 可读中文”的恢复有效。
- 所以这部分已经回退，当前日志主线保持原样，避免把不稳定逻辑混进已跑通链路。

本轮收口后的验证结果：

- `node --test test\launch-error.test.js`
- `node --check main\index.js`
- `node --check main\websocket.js`
- `node --check main\logger.js`

结果：全部通过。

## 2026-06-24 main/index.js 拆分完成

- `main/index.js` 现在只保留主进程组装职责：窗口创建、服务启动、IPC 注册、运行时依赖装配。
- 本轮已正式拆出三个模块：
  - `main/pdd-bridge-runtime.js`：PDD bridge 脚本生成、HTTP bridge 服务、页面命令处理。
  - `main/chat-handlers.js`：启动、发送、聚焦会话、恢复接待、tmagent 自动回复编排。
  - `main/pdd-observers.js`：PDD/QN 状态监听、bridge health 观察、WBChat 文件变化观察。
- 这次拆分顺手修掉了两个回归点：
  1. `bindPddStatusEvents()` 默认 logger 不能落到真实文件 logger，否则单测会把 `%LOCALAPPDATA%` 写穿。
  2. `createAutoReplyHandler()` 默认 `handoffStore` 不能直接复用进程级单例，否则测试之间会串会话静音状态。
- 当前约束已经明确：
  - 运行时主链路如果要共享 `handoffStore`，必须由 `startServices()` 显式传入。
  - 对外导出的工厂函数默认要保持无副作用、可测试、实例隔离。
- 已完成回归验证：
  - `node --test test\launch-error.test.js`
  - `node --check main\index.js`
  - `node --check main\pdd-bridge-runtime.js`

## 2026-06-24 PDD 会话能力第一批完成

- 本轮先把 PDD 的三项会话能力补齐到底层可调用状态：
  - `getCurrentCsr`
  - `getCurrentConv`
  - `getRemoteHisMsg`
- 实现位置：
  - bridge 命令处理：`main/pdd-bridge-runtime.js`
  - 主进程命令下发：`main/chat-handlers.js` + `main/index.js`
  - preload 暴露：
    - `getCurrentPddCsr()`
    - `getCurrentPddConv(payload)`
    - `getPddRemoteHistory(payload)`
- 当前行为：
  - `getCurrentCsr` 会回传当前客服信息，事件类型 `currentCsr`
  - `getCurrentConv` 会回传当前打开会话，事件类型 `currentConv`
  - `getRemoteHisMsg` 会调用 `/plateau/chat/list` 拉取远程历史消息，事件类型 `remote_his_message`
- 这些返回目前已经能通过现有 `ws:protocol-message` / diagnostics 通道进入主进程。
- 同轮顺手修复了一个稳定性问题：`createAutoReplyHandler()` 现在在显式传入 `tmagent` 配置时，会优先启用 tmagent，不再被本地 AI 设置里的 `enabled` 意外压掉，避免测试和运行时行为漂移。
- 已完成回归验证：
  - `node --test test\message-parser.test.js`
  - `node --test test\launch-error.test.js`
  - `node --check main\pdd-bridge-runtime.js`
  - `node --check main\chat-handlers.js`
  - `node --check preload\index.js`

## 2026-06-24 PDD 转接探针

- `P2.3` 当前先不实现本地 `transfer_conversation_2` 动作，先抓 PDD 客户端真实转接执行面。
- 已在 `main/index.js -> createPddBridgeScript()` 增加 PDD 转接专用 probe，当前会额外记录：
  - `transfer-click`
  - `transfer-ui`
  - `transfer-xhr-open`
  - `transfer-xhr-send`
  - `transfer-xhr-load`
  - `transfer-fetch-request`
  - `transfer-fetch-response`

## 2026-06-24 PDD 订单能力第二批完成

- 本轮先完成 PDD 第二批订单能力的底层命令链路：
  - `queryOrderRemark`
  - `setOrderRemark`
  - `autoOrderMessage`
- 实现位置：
  - bridge 命令处理：`main/pdd-bridge-runtime.js`
  - 协议识别：`main/message-parser.js`
  - 主进程命令下发：`main/chat-handlers.js` + `main/index.js`
  - preload 暴露：
    - `queryPddOrderRemark(payload)`
    - `setPddOrderRemark(payload)`
    - `sendPddOrderMessage(payload)`
- 当前行为：
  - `queryOrderRemark` 调 `/pizza/order/noteTag/query` 查询订单备注，回传 `queryOrderRemarkResult`
  - `setOrderRemark` 调 `/pizza/order/noteTag/update` 写订单备注，回传 `setOrderRemarkResult`
  - `autoOrderMessage` 先调 `/chats/getUserByOrderSn` 解析买家 UID，再走现有 `socketUtil.sendMsg` 发文本，回传 `autoOrderMessageResult`
- 命令透传规则已补齐：
  - `createPddCommandHandler()` 现在支持把 `payload.params` 原样下发到 bridge，适合这一批订单命令。
- 当前仍未做：
  - 真实客户端上的逐项人工联调
- 已完成回归验证：
  - `node --test test\message-parser.test.js`
  - `node --test test\launch-error.test.js`
  - `node --check main\pdd-bridge-runtime.js`
  - `node --check main\chat-handlers.js`
  - `node --check main\index.js`
  - `node --check preload\index.js`

## 2026-06-24 启动台接入 PDD 会话工具 UI

- 现有右侧 `toolsDrawer` 已新增 `会话工具` tab，承接第一批和第二批能力，不单开页面，不改商品库。
- 第一批 UI 已接入：
  - 读取当前客服 `getCurrentPddCsr()`
  - 读取当前会话 `getCurrentPddConv(payload)`
  - 拉取远程历史 `getPddRemoteHistory(payload)`
- 第二批 UI 已接入：
  - 查询备注 `queryPddOrderRemark(payload)`
  - 保存备注 `setPddOrderRemark(payload)`
  - 按订单发消息 `sendPddOrderMessage(payload)`
- renderer 行为：
  - 第一批结果通过 `ws:protocol-message` 中的 `currentcsr` / `currentconv` / `remote_his_message` 回填到会话工具页
  - 第二批结果通过 `queryorderremarkresult` / `setorderremarkresult` / `autoordermessageresult` 回填到订单结果区
  - 查询备注成功后会自动回填备注内容、标签颜色、标签名称输入框
- 本轮只做启动台 UI 和调用链，不做悬浮插件同步，不做商品能力。
- 已完成回归验证：
  - `node --test test\launch-error.test.js`
  - `node --check renderer\app.js`
  - `node --check preload\index.js`
  - `rg -n "tabSessionTools|sessionToolsPane|loadCurrentCsrButton|queryOrderRemarkButton|sendOrderMessageButton" renderer\index.html`
  - `transfer-window-message`
  - `transfer-window-post-message`
  - `transfer-native-event`
- 这轮 probe 只做观测，不改现有 PDD 收消息、tmagent、自动发送主链。
- 当前已知 UI 路径已确认：
  - 顶部 `转移会话`
  - 弹窗行内 `转移`
  - 原因项 `无原因直接转移`
- 下一轮实测目标不是“是否转接成功”，而是先确认最终执行面到底落在：
  - HTTP/XHR/fetch
  - 页面消息/DOM
  - 原生壳事件
- 自动化验证已通过：
  - `node --check main\index.js`
  - `node --test test\launch-error.test.js`

## 2026-06-24 P0 验收结果

- Diagnostics 区已补充 tmagent 生效配置摘要，能直接看到：
  - enabled
  - baseUrl
  - merchantName
  - tenantId
  - API key 掩码
- tmagent 出站前会记录 `[auto-reply:tmagent-request]`，包含：
  - endpoint
  - platform
  - shopId / shopName
  - buyerId
  - conversationId
  - messageType
  - 掩码后的 API key
- tmagent 返回后会记录 `[auto-reply:tmagent-response]`，用于快速判断是正常回复、空回复还是 `human_takeover`。
- 当 tmagent 返回 `action: "human_takeover"` 时：
  - 当前会话不会自动发送
  - 会记录 `[auto-reply:handoff]`
  - 同一会话后续买家消息会被会话级静音，日志原因为 `human-takeover-muted`
- 当前已完成的 P0 自动化验收：
  - `node --check main\index.js`
  - `node --check renderer\app.js`
  - `node --check main\tmagent-client.js`
  - `node --check main\message-parser.js`
  - `node --test test\launch-error.test.js`
  - `node --test test\ai-settings-store.test.js`
- 结果：`launch-error` 22/22 通过，`ai-settings-store` 3/3 通过。

## 2026-06-24 P1 收口结果

- `main/message-parser.js` 已补统一结构化消息字段：
  - `messageType`
  - `card`
  - `orderFacts`
- 当前已稳定的结构化映射：
  - PDD `kind=text -> messageType=text`
  - PDD `kind=goods -> messageType=product_card`
  - PDD `kind=order -> messageType=order_card`
  - QN 当前仍按文本消息进入统一骨架，默认 `orderFacts` 为无订单
- `orderFacts` 当前统一字段为：
  - `hasOrder`
  - `orderStage`
  - `orderSummary`
  - `customerStage`
  - `customerStageSource`
- 当前已落地的订单阶段骨架：
  - `no_recent_order`
  - `pending_payment`
  - `paid_pending_shipment`
  - `shipped`
  - `completed`
  - `after_sale`
  - `unknown_order_state`
- `main/tmagent-client.js` 已改为消费这套结构化字段，不再把所有消息硬编码成纯 text/no_order：
  - `buyer_id` 优先取 `message.senderId`，再回退 `conversationId`
  - `conversation_id` 统一按 `${platform}:${shopId}:${buyerId}` 生成
  - 平台名归一：
    - `publicplatform -> pdd`
    - `qn -> qianniu`
  - `message_type / card / has_order / order_stage / order_summary / customer_stage / customer_stage_source` 都会跟随解析结果进入 tmagent payload
- 当前已完成的 P1 自动化验收：
  - `node --test test\message-parser.test.js`
  - `node --test test\tmagent-client.test.js`
  - 回归合并验证：
    - `node --test test\launch-error.test.js test\ai-settings-store.test.js test\message-parser.test.js test\tmagent-client.test.js`
- 结果：
  - `message-parser` 10/10 通过
  - `tmagent-client` 6/6 通过
  - 合并回归 41/41 通过

## 2026-06-24 PDD 双发根因与修复

- 真实日志已确认：同一条买家消息会被 PDD bridge 以两种 source 重复上报：
  - `recv_message`
  - `pinnotification.MMSSocketReceiveMessage`
- 两次上报里的 `msgId` 相同，但旧逻辑是在 tmagent 返回并发送后才把 `messageKey` 放进 `seenMessageIds`，导致并发窗口内两次事件都能通过去重检查，最终触发两次 tmagent 请求和两次发送。
- 已修复：
  - `createAutoReplyHandler()` 新增 `inFlightMessageIds`
  - 在进入 tmagent / 发送前先占位
  - 并发重复事件直接记为 `duplicate-inflight`
  - 成功发送或 `human_takeover` 后再落入 `seenMessageIds`
- 同次排查还确认了第二个问题：
  - PDD 某些消息路径里原先 `senderId` 会被解析成 `undefined`
  - 已改为优先从 `from.uid`、`fromId`、`uid`、`buyerId` 等来源提取真实买家 id
- 新增自动化覆盖：
  - `auto reply handler deduplicates concurrent duplicate buyer messages by message id`
  - `parses PDD buyer senderId from nested from uid`
- 当前已完成验证：
  - `node --test test\launch-error.test.js`
  - `node --test test\message-parser.test.js`
  - `node --test test\tmagent-client.test.js`
  - `node --check main\index.js`
  - `node --check main\message-parser.js`

## 2026-06-23 Python helper 试跑

- 用户提供的 `D:\majiang\fuke_helper\fuke_helper.py` 已复制为 `helper-python\PddFukeHelper.py`。
- 试跑方式：临时用 Python 启动 helper，并让它连接 `/Extend` 后执行 QN `launch_platform`。
- 结果：helper 可握手并响应 `launch_platform`，返回 `pid=35784`。
- 但日志 `C:\Users\26799\AppData\Local\huihui\logs\Extend\fuke-helper-python.txt` 显示 `admin=False`、`WriteProcessMemory: 0/114 bytes`、`LoadLibraryW returned: 0xC0000005`。
- 结论：这次 Python helper 没有完成有效 DLL 注入，尚未进入千牛发送验证；下一步若继续用它，需要先修注入/提权问题。
# 2026-06-23 QN send probe

- Added a temporary probe at the top of `fuke-qn-hh-4.3.js` to log manual send activity.
- The probe watches `imsdk.invoke`, `QN.app.invoke`, `pinbridge.callNative`, DOM click, and Enter key events, then emits `[qn-probe][...]` logs through the local QN WebSocket when possible.
- The current Electron bridge reads `fuke-qn-hh-4.3.js` once at bridge-server startup, so the probe only takes effect after restarting the launcher/QN bridge and reloading the QN chat page.
- Current send blocker remains: auto route `sendMsg -> intelligentservice.SendSmartTipMsg` times out, while manual merchant send is observed as QN `newMsg` with `extLocal.LocalSendMsg=SendByThisDev`.

## 2026-06-23 PDD C# helper regression

- Started the launcher with `PDD_FUKE_USE_CSHARP_HELPER=1`; PDD used `helper-csharp\bin\PddFukeHelper.exe`, not the original Fuke helper.
- Verified `launch_platform` started `pdd-workbench\PddWorkbench.exe` PID `16952` and injected `D:\Program Files\fuke\assets\inject\PddExtend-3.5.7.16.dll`.
- Verified `PDDExtend` injected `http://127.0.0.1:64762/pdd-bridge.js` and connected to local WebSocket `127.0.0.1:64761`.
- Verified buyer message receive path with new message content `好的` at `2026-06-23 21:48:29`; it appeared in `PDDExtend_35716_log.txt` as native `recv_message`.
- Not yet confirmed in logs: whether this specific buyer message triggered application-level auto-reply and produced a merchant-direction outbound message.
- Follow-up root cause: PDD bridge emits `ts` in seconds, while stale-message filtering compares millisecond timestamps. This made fresh buyer messages look stale and skip auto reply.
- Fixed `main/message-parser.js` to normalize second timestamps to milliseconds and added a regression test in `test/message-parser.test.js`.
- Live PDD regression after the fix: buyer message at `2026-06-23 21:57:35` produced `[auto-reply:sent]` at `21:57:38`, followed by `pdd-send-callback`; PDD receive -> tmagent -> send is confirmed working again.

## 2026-06-23 QN latest send evidence

- Same live test: QN buyer messages triggered tmagent and application-level `[auto-reply:sent]`.
- Native QN sending still failed: `send_text_message` returned `responseCode=1`, `SendSmartTipMsg` timed out, and DOM fallback reported `DOM send button not found`.
- Current conclusion: QN receive and AI generation are working; blocker is still the QN send execution layer, not tmagent or message parsing.

## 2026-06-23 C# helper injection mode experiment

- C# helper now supports selectable remote-thread injection modes: default `remote-thread-a` keeps the old `LoadLibraryA` path; `remote-thread-w` uses `LoadLibraryW` and UTF-16 DLL path bytes.
- QN manager passes `inject_mode` when `PDD_FUKE_INJECT_MODE` is set, so we can run QN with `PDD_FUKE_INJECT_MODE=remote-thread-w` without changing platform JS or DLL files.
- Built test binary `helper-csharp\bin\PddFukeHelper-unicode.exe`; `PddFukeHelper-parity.exe` was locked by a running process, so it was not overwritten.
- Verification passed: `node --test test\helper-csharp.test.js test\qn-manager.test.js`.
- Live `remote-thread-w` verification: QN launched with `PddFukeHelper-unicode.exe`, `mode=remote-thread-w`, and `LoadLibraryW`; buyer messages still reached QN DLL as `send_text_message` / `SendTextMsg`, but no auto-reply appeared in the QN UI.
- New experimental mode `thread-context-w` was added to approximate Fuke helper's `GetThreadContext` / `SetThreadContext` / `ShellCodeInject` clue. It installed the loader and resumed the main thread, but QN did not start normally and no fresh `QNExtend_96320_log.txt` was produced.
- Current conclusion: do not use `thread-context-w` as a working path yet. Revert live testing to `remote-thread-w` or the previous parity helper while investigating the context-loader stub or Fuke helper's real shellcode behavior.
- QN manager now blocks duplicate launches while a launch is in-flight and ignores repeated launch clicks for a short cooldown after a successful start. This prevents accidental repeated QN restarts from overwriting live send-test evidence. Verification passed: `node --test test\helper-csharp.test.js test\qn-manager.test.js`.
- `thread-context-w` root cause found and fixed: the loader saved `rsp` in volatile `r11` across `LoadLibraryW`; Windows x64 allows the callee to clobber `r11`, which can corrupt stack restore and break QN startup. It now saves/restores through nonvolatile `rbp`.
- Verification passed after the fix: `node --test test\helper-csharp.test.js test\qn-manager.test.js` reported 21/21 passing, and `helper-csharp\bin\PddFukeHelper.exe` was rebuilt.
- Live QN verification with `PDD_FUKE_INJECT_MODE=thread-context-w` succeeded at `2026-06-23 22:48`: QN launched, buyer message `809` triggered `textSource: 'tmagent'`, `send_text_message` returned `statusLabel=成功` / `SendTextMsg callback: code:0`, and QN emitted the merchant-direction `newMsg`. Current conclusion: QN receive -> tmagent -> native send is confirmed working with our C# helper.

## 2026-06-23 QN self-owned JS bridge start

- Added `docs/qn-js-interface-map.md`, extracting the minimum QN JS interfaces from the currently working behavior instead of copying the full Fuke script.
- Added `bridges/qn-bridge-lite.js`, a first self-owned QN bridge focused only on the core path: WebSocket connect, buyer/merchant message forwarding, `switchConversation`, and `sendMsg/sendtext`.
- QN lite send route uses the confirmed native interface: `window.NativeCall("send_text_message", { ccode, text })`, not a global `send_text_message` function.
- Added `PDD_FUKE_QN_BRIDGE=lite` switch in `main/index.js`. Default remains the existing Fuke QN script, so the known-working path is not replaced unless explicitly enabled.
- Verification passed: `node --check bridges\qn-bridge-lite.js`, `node --test test\launch-error.test.js`, and `node --test test\helper-csharp.test.js test\qn-manager.test.js`.
- Live QN lite verification succeeded at `2026-06-23 23:29`: launcher was started with `PDD_FUKE_QN_BRIDGE=lite` and `PDD_FUKE_INJECT_MODE=thread-context-w`; QN connected as `/?platform=qn&bridge=lite`, buyer message triggered `[qn-bridge-lite] event onReceiveNewMsg`, tmagent reply sent through `window.NativeCall("send_text_message", { ccode, text })`, callback returned `statusLabel=success`, and QN emitted the merchant-direction assistant message. Current conclusion: the first self-owned QN JS bridge has confirmed the core receive -> tmagent -> native send path.

## 2026-06-24 Product-first dependency strategy

- Current priority is product functionality, not replacing the native core files immediately.
- Use the verified stable runtime path while building product features: keep Fuke platform DLLs for now, keep the working C# helper path, and use the verified bridge path per platform (`qn-bridge-lite.js` is already live-confirmed for QN core receive/send).
- Defer self-owned DLL replacement until the product surface is complete enough to validate against real workflows. Core replacement should be done later behind explicit switches and parity tests, one capability at a time.

## 2026-06-24 PDD transfer observation gate

- Added a bridge-observation state machine in `main/index.js` for the PDD bridge diagnostics path.
- The launcher now tracks four separate facts instead of one vague “bridge connected” impression:
  - bridge HTTP script server started
  - PDD `/publicplatform` WebSocket client connected
  - page emitted `page-ready`
  - current transfer observation trace id
- Live bridge diagnostics are now annotated in-process:
  - transfer diagnostics only get a `traceId` after the gate is fully ready
  - if the gate is not ready, transfer diagnostics include `bridgeReady: false` plus the current gate snapshot
  - the first ready `transfer-click` opens a new trace id, and later `transfer-*` events reuse it
- Added bridge-lifecycle probes so one click can now classify where the failure lives:
  - `bridge-script-start`
  - `bridge-ws-construct`
  - `bridge-ws-open`
  - `bridge-ws-error`
  - `bridge-ws-close`
  - `window-error`
  - `unhandled-rejection`
  - `document-click-capture`
  - `iframe-scan`
- Added a non-WebSocket fallback path for early bridge execution evidence:
  - bridge script now sends HTTP image beacons to `/pdd-bridge-beacon`
  - current beacon checkpoints are:
    - `bridge-js-loaded`
    - `bridge-js-after-websocket-construct`
    - `bridge-js-install-probe`
  - this is specifically for the case where `/pdd-bridge.js` is requested but no websocket client or `page-ready` ever appears
- Renderer diagnostics now expose these states directly:
  - `Bridge HTTP`
  - `Bridge WS`
  - `Page ready`
  - `Transfer trace`
- This change is aimed at the current P2.3 problem: invalid transfer-click experiments can now be distinguished from real in-page observations, instead of mixing “script was served” with “bridge is actually alive”.
- Verification completed:
  - `node --test test\launch-error.test.js`
  - `node --check main\index.js`
  - `node --check preload\index.js`
  - `node --check renderer\app.js`

## 2026-06-24 PDD delayed CDP recovery

- 这轮排查确认了一个新的确定性问题，不是猜测：
  - PDD 的 `19999` CDP 端口并不会稳定在启动后 5 秒内就绪。
  - 我们原来的 `main/pdd-manager.js` 只在启动后单次调用 `scheduleCdpConnect(5000)`。
  - 实际日志里经常出现“5 秒时全端口扫描失败，几秒后 `19999` 才开始监听”的情况，所以 UI 会长期停在 `CDP 未连接`，后续也不会自愈。
- 已验证的现场证据：
  - 新一轮实机里，早期日志全部是 `connect ECONNREFUSED`。
  - 但随后本机 `netstat` 已看到 `127.0.0.1:19999 LISTENING`。
  - `http://127.0.0.1:19999/json/list` 已能列出真实 PDD targets，其中包含：
    - `聊天详情` -> `.../view/middle_panel/index.html`
    - `商品订单` -> `.../view/right_panel/index.html`
- 已做修复：
  - `main/pdd-manager.js` 新增 PDD CDP 有界重试：
    - 初始延迟 `5000ms`
    - 重试间隔 `2000ms`
    - 最大尝试 `12` 次
  - 一旦 CDP 真正连上，不再只标记状态，而是立刻在 `middle_panel` 里走一次 CDP 注入兜底：
    - 优先按 `JS_URL` 动态创建 `<script src=".../pdd-bridge.js">`
    - 没有 `JS_URL` 时才退回旧的裸 WebSocket 注入
- 这意味着当前 PDD 桥接策略从“只赌 DLL 自己把外部 JS 执行起来”变成了“双保险”：
  - 第一层：DLL 既有 `JS_URL` 注入链
  - 第二层：CDP 晚到后自动补注入真实 `middle_panel`
- 新增自动化覆盖：
  - `pdd manager retries delayed CDP availability and injects bridge script after connect`
  - `pdd manager injectBridgeScript prefers JS_URL script injection when available`
- 当前验证完成：
  - `node --test test\test-pdd-manager.js`
  - `node --check main\pdd-manager.js`

## 2026-06-24 PDD five-layer unified survey

- 为了继续定位 PDD `transfer_conversation_2`，这轮不再只盯 `middle_panel` 单页，也不再靠桥接脚本有没有真正执行来赌结果。
- 已新增一条独立于现有收发链路的“五层统一探针”：
  - 入口仍在 `main/pdd-manager.js`
  - 通过 `main/cdp-manager.js` 先拉取同一调试端口下的 `/json/list`
  - 自动挑选最相关的前 5 个 page target，优先级大致是：
    - `聊天详情 / middle_panel`
    - `商品订单 / right_panel`
    - `notification / knock / sidebar`
    - 其他 `mms.pinduoduo.com` workbench 页
- 对这些 target，不再复用现有 bridge，而是单独开临时 CDP session 做最小注入：
  - 安装 DOM click 捕获
  - 安装 `window.message`
  - 安装 `fetch`
  - 安装 `XMLHttpRequest`
  - 同时记录 `socketUtil` / `pinnotification` / `OnNativeEvent` / `webpackChunk*` / `iframe,webview` 数量
- 探针事件不会走页面 websocket，而是写入页面内队列，主进程按轮询间隔主动 drain：
  - 这样即使外部 `/pdd-bridge.js` 没真正跑起来，也能继续拿到点击和请求痕迹
  - 诊断事件统一进入 Electron 诊断流，事件名包括：
    - `layer-survey-targets`
    - `layer-survey-installed`
    - `layer-survey-event`
    - `layer-survey-target-error`
- 当前目的很明确：
  - 先确认“转移会话”动作到底落在哪个 target / 哪类上下文
  - 再决定是继续走页面接口、页面事件总线，还是必须下沉到更深层 native 路径
- 这轮只加了诊断编排，没有改动现有 PDD 收发实现。
- 新增验证：
  - `node --test test\test-cdp-manager.js test\test-pdd-manager.js`
  - `node --check main\cdp-manager.js`
  - `node --check main\pdd-manager.js`
  - `node --check main\index.js`

## 2026-06-24 PDD 转接最小实现

- 当前结论已经从“追按钮层级”收口到“走业务接口层”：
  - 先调 `/latitude/assign/getAssignCsList`
  - 再调 `/plateau/chat/move_conversation`
- 这条链路属于 **PDD bridge JS 业务接口层**，不是 helper/DLL 层，也不是鼠标点击层。
- 已在 `main/index.js -> createPddBridgeScript()` 增加最小转接执行面：
  - bridge 现在支持接收 `act: 'transferConversation'`
  - 会在页面登录态内调用：
    - `/latitude/assign/getAssignCsList`
    - `/plateau/chat/move_conversation`
  - 当前目标选择规则先做成确定性最小版：
    - 优先用命令里显式 `toId/accountId/csrName`
    - 否则优先匹配 `主账号`
    - 如果只有一个客服账号，就直接用这个唯一账号
    - 多目标且无法唯一确定时，直接失败，不盲转
- `createAutoReplyHandler()` 现已支持 tmagent 返回 `action: "transfer_conversation_2"`：
  - 若有 `reply`，先照常发给买家
  - 然后向 PDD bridge 下发 `transferConversation`
  - 本地会话随即进入静音，后续买家消息按 `human-takeover-muted` 跳过，不再继续 AI 接待
- 当前 `human_takeover` 保持原逻辑：
  - 不做真实转接
  - 只把当前会话本地静音
- 新增自动化覆盖：
  - `auto reply handler sends reply then requests PDD transfer when tmagent asks for transfer_conversation_2`
  - `auto reply handler mutes the conversation after transfer_conversation_2 request`
  - bridge server 脚本内容已断言包含：
    - `transferConversation`
    - `getAssignCsList`
    - `move_conversation`
    - `transfer-result`
- 当前验证完成：
  - `node --check main\index.js`
  - `node --test test\launch-error.test.js`

## 2026-06-24 悬浮插件待人工处理闭环

- 悬浮插件这轮不再只做本地 `manualConversationIds` 假状态，已经把“人工接管会话”提升为主进程共享状态：
  - `main/index.js` 新增 `createConversationHandoffStore()`
  - `human_takeover` 和 `transfer_conversation_2` 都会写入这个 store
  - 后续买家消息命中已接管会话时，仍按 `human-takeover-muted` 跳过
  - 点击“继续接待”时，会从 store 清掉该会话，恢复自动接待资格
- 这意味着“待人工处理”已经从单纯 UI 标记，变成了真实的主进程控制面：
  - `app:get-status` 现在会返回 `handoff.manual`
  - 主进程会向渲染层广播 `conversation:manual-state`
  - preload 暴露了：
    - `focusConversation(payload)`
    - `resumeConversation(payload)`
    - `onManualState(callback)`
- PDD bridge JS 这轮补上了缺失的切会话能力：
  - 新增 `act: 'switchConversation'`
  - 通过页面内 `NativeCall('switch_conversation', { to_id })` 切主客户端到目标会话
  - 所以悬浮插件点客户卡片，已经不是本地高亮，而是会请求真实客户端切到该会话
- 悬浮插件 UI 已完成最小闭环：
  - 新增 tab：
    - `待回复`
    - `待人工处理`
  - `待人工处理` tab 会显示 badge 数量
  - 卡片显示“自客户第一条未回复消息开始”的等待时长
  - 点卡片会触发主客户端跳转
  - 点“继续接待”会清掉人工卡片
- 当前验证完成：
  - `node --check main\index.js`
  - `node --check renderer\floating.js`
  - `node --test test\launch-error.test.js`
