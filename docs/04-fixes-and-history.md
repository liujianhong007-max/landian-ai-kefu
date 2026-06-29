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

## 当前待解决
- DLL 注入后 WebSocket 连接正常，但消息 Hook 未触发
- 初步分析可能是 DLL 的 C++ 函数地址与 PDD 3.5.7.16 实际二进制不完全匹配
- STUB+FULL DLL 分离架构需要双 DLL 同时注入同一进程
