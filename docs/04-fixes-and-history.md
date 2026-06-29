# 开发历程与关键修复记录

## 修复 1：FIFO 队列修复 Helper 协议
- **问题**：launch_platform 始终超时 15s
- **根因**：handleMessage 用 `frame.id` 匹配响应，但 helper 响应中 body.id=null
- **修复**：`this.pending` 从 Map 改为 Array (FIFO)，匹配条件改为 `frame.body?.success !== undefined`
- **文件**：`main/pdd-manager.js` HelperClient 类

## 修复 2：PDD 版本降级
- **问题**：当前 PDD 3.6.7.6 无匹配 DLL
- **根因**：PDD 自动升级到不兼容版本
- **修复**：切换到 PDD 3.5.7.16 + PddExtend-3.5.7.16.dll
- **来源**：`%LOCALAPPDATA%\huihui\pdd\3.5.7.16\`（原 fuke 管理的版本）

## 修复 3：DLL 恢复
- **问题**：DLL 被替换为 139KB stub，PDD 启动即崩溃
- **根因**：PddExtend-3.5.7.16.dll 被替换为 STUB 版本
- **修复**：从 .bak 恢复 1.2MB 原始 DLL

## 修复 4：窗口恢复
- **问题**：pdd-fuke UI 窗口不可见
- **根因**：窗口坐标被设为 (-32000, -32000)
- **修复**：Win32 ShowWindow(SW_RESTORE) + SetForegroundWindow

## 修复 5：调试参数移除
- **问题**：`--remote-debugging-port=19999` 触发 PDD "程序不完整" 检查
- **根因**：PDD 安全模块检测到调试参数
- **修复**：从 DEFAULT_ARGS 中移除该参数

## 修复 6：更新抑制策略
- **问题**：PDD 弹出更新提示
- **根因**：PDDUpdate.exe 未被处理
- **当前策略**：保留 PDDUpdate.exe，不使用删除策略（避免完整性检查）

## 修复 7：PDD bridge 重注入后消息链路断开
- **问题**：浮窗 Diagnostics 显示已有 `1 client`，探针和本地库变化也正常，但买家新消息不再进入自动回复链路；浮窗还可能错误显示“未启动/等待连接”。
- **根因**：
  1. `createPddBridgeScript()` 增加诊断/转接探针逻辑后，PDD 页面发生二次注入。
  2. 第一次注入安装的 native hook 持有局部 `socket` 闭包。
  3. 第二次注入创建新 WebSocket，并关闭旧 socket。
  4. hook 没有重绑，后续业务消息继续发往旧 socket，结果只剩探针可见，`ws:pdd-message-parsed` 消失。
  5. 同时 `publicplatform` 没有在部分状态逻辑里归一化为 `pdd`，造成浮窗状态假异常。
- **修复**：
  - bridge 脚本统一通过 `window.__pddFukeBridgeSocket` 发送业务消息和诊断，避免吃旧闭包；
  - 主进程 bridge health 与浮窗状态统一把 `publicplatform` 视作 PDD。
- **验证**：
  - `node --check main\index.js`
  - `node --check renderer\floating.js`
  - `node --test test\launch-error.test.js`
  - 真实日志确认恢复：买家消息重新进入 `[ws:pdd-message-parsed]`，随后出现 `[auto-reply:tmagent-request]` 和 `[auto-reply:sent]`。
- **规避规则**：
  - 页面注入脚本只要允许重复执行，hook 绝不能绑定局部连接对象；
  - 平台名必须统一归一化，不能让 `publicplatform` / `pdd` 在不同模块里各自处理；
  - 每次改 bridge 功能，都要回归“二次注入 + 新买家消息 + 自动回复”这条链路。

## 修复 8：2026-06-30 CodeBuddy 混乱恢复与干净 Git 历史
- **背景**：CodeBuddy 连续改动后，项目出现半迁移状态，`lg` / `fuke` / `landian` 命名、helper 路径、DLL 路径、renderer DOM 兼容和 tmagent payload 契约混在一起；用户实测启动台可登录，但最初“启动拼多多”只能弹 helper，不能拉起 PDD 客户端。
- **保留点**：
  - 原救援分支：`codex/rescue-pdd-fuke-cleanup`
  - 本地可用 tag：`rescue-working-2026-06-30`
  - 救援提交：`b748e488 fix: restore pdd fuke launch and auto-reply flow`
  - 干净远端分支：`origin/codex/clean-history`
  - 干净历史根提交：`7d424b20 chore: create clean project history without workbench binaries`
- **关键修复**：
  - `main/pdd-manager.js` 默认 helper 恢复为 fuke/PddFukeHelper 路线，并兼容旧 `PDD_LG_*` 环境变量。
  - `main/pdd-manager.js` 的 DLL 解析改为只把真实存在的 DLL 传给 helper；干净历史默认使用 `assets/inject/PddExtend-3.5.7.16.dll`，本地有 `pdd-workbench/PddExtend-3.5.7.16.dll` 时也可用。
  - `main/logger.js` 日志目录恢复为 `%LOCALAPPDATA%/pdd-fuke/logs/main.log`。
  - `main/own-helper.js` hello 握手恢复为 `platform: "fuke-helper"`、`version: "pdd-fuke-helper"`。
  - `main/tmagent-client.js` 和 `main/chat-handlers.js` 恢复 tmagent chat payload、自动回复 flush 返回值、PDD send failure 诊断和 QN 切会话发送逻辑。
  - `main/pdd-bridge-runtime.js` 统一为 `__pddFuke*` bridge 全局名，并保留 QN bridge 环境变量兼容。
  - `renderer/app.js`、`renderer/launcher.js` 增加空 DOM 防护，恢复启动台状态渲染和店铺 AI 开关测试契约。
  - `renderer/index.html`、`renderer/product-library.html`、`renderer/ai-settings.html` 恢复测试要求的关键中文文案。
- **真实验证**：
  - 用户确认：客户端能登录、能进工作台、点击启动拼多多能拉起 PDD 客户端、自动回复已工作。
  - 自动化验证：`npm test` 通过，153 pass / 1 skip / 0 fail。
- **Git 清理**：
  - 旧历史包含完整 `pdd-workbench/`，`.git` pack 约 4.41 GiB，且存在 100MB+ 文件，例如 `pdd-workbench/pddbrowser104/chrome.dll`。
  - 为避免 GitHub 拒绝大文件，创建 orphan 分支 `codex/clean-history`，只保留代码、配置、文档和小型 `assets/inject/*.dll`。
  - `.gitignore` 已加入 `pdd-workbench/` 与 `helper-native/custom-dll/build/`。
  - `codex/clean-history` 最大 tracked 文件约 1.21MB，已成功 push 到 GitHub。
- **后续规则**：
  - 不要再把完整客户端目录 `pdd-workbench/` 加回 Git。
  - 如果需要 PDD 客户端，走本地放置、版本管理下载或外部制品，不走 Git 源码仓库。
  - 后续开发应基于 `codex/clean-history`，不要从旧 `master` 的 4GB 历史继续派生。

## 修复 9：2026-06-30 启动参数本地配置化
- **背景**：当前可用版本恢复后，启动台仍有部分路径和开关散落在环境变量或代码默认值里，不利于后续换机器、换 helper 或切桥接模式。
- **处理**：
  - 新增 `config/launch-settings.local.json` 作为本机启动参数文件；该文件已加入 `.gitignore`，不会上传个人路径。
  - 新增 `config/launch-settings.example.json` 作为可提交模板。
  - 当前支持字段：`pdd.exePath`、`pdd.helperPath`、`pdd.dllPath`、`qn.exePath`、`qn.helperPath`、`qn.dllPath`、`qn.injectMode`、`qn.launchCooldownMs`、`qnBridge`。
  - `qnBridge` 默认 `fuke`，只有明确写成 `lite` 时才切到 lite 桥接脚本。
- **验证**：
  - `node --test test\launch-settings-store.test.js`
  - `node --test test\test-pdd-manager.js`
  - `node --test test\qn-manager.test.js`
  - `node --test test\pdd-bridge-runtime.test.js test\launch-error.test.js`

## 修复 10：2026-06-30 PDD 客户端残缺目录与空解压缓存
- **问题**：启动 `PddWorkbench.exe` 时连续弹系统错误，提示找不到 `zlib1.dll`、`LIBEAY32.dll`、`SSLEAY32.dll`。
- **根因**：
  - Git 干净历史不再保存完整 `pdd-workbench/` 客户端目录，本机残留的项目内 `pdd-workbench/` 只有 exe 和部分文件，缺 PDD 自带运行 DLL。
  - 本地版本缓存里已有 `pdd-workbench-3.5.7.16.zip`，但 `extracted/` 是空目录；旧版本管理逻辑只判断 `extracted/` 是否存在，空目录也会被误认为可用。
- **处理**：
  - 已将本地缓存包 `pdd-workbench-3.5.7.16.zip` 解压到 `%LOCALAPPDATA%\pdd-fuke\workbenches\pdd\3.5.7.16\extracted`，并确认 `PddWorkbench.exe`、`zlib1.dll`、`libeay32.dll`、`ssleay32.dll` 存在。
  - `PddManager.resolveExePath()` 只接受包含必要运行 DLL 的 PDD 目录；项目内残缺 `pdd-workbench/` 会被跳过。
  - `oss-version-manager` 只有在解压目录里存在平台对应 exe 时，才认为本地版本可用，避免空 `extracted/` 阻止重新解压/下载。
- **验证**：
  - `node --test test\launch-error.test.js test\test-pdd-manager.js test\oss-version-manager.test.js test\launch-settings-store.test.js test\pdd-bridge-runtime.test.js test\qn-manager.test.js`
  - `node --check main\pdd-manager.js`
  - `node --check main\oss-version-manager.js`
  - `node --check main\index.js`

## 当前待解决
- DLL 注入后 WebSocket 连接正常，但消息 Hook 未触发
- 初步分析可能是 DLL 的 C++ 函数地址与 PDD 3.5.7.16 实际二进制不完全匹配
- STUB+FULL DLL 分离架构需要双 DLL 同时注入同一进程
