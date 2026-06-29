# CodeBuddy 代码调整记录

## 2026-06-25：发送失败问题诊断

### 问题现象

自动回复发送环节出现失败，日志显示：
```
[auto-reply:send-failed] { targetId: '8446747828012', error: 'Uncaught TypeError: m is not a function', failureType: 'window-error' }
```

### 根因分析

**不是本项目代码的问题，是拼多多工作台前端版本更新引入的 bug。**

#### 版本变化时间线

| 时间 | 拼多多页面版本 | 状态 |
|------|---------------|------|
| 6月19日 ~ 6月24日 06:22 | `web_19.5.0` | ✅ 正常 |
| 6月24日 07:22 起 | `web_19.20.0` | ⚠️ 出现 `window-error` |
| 6月24日 08:25 起 | `web_19.20.0` | 🔴 发送失败开始 |

拼多多在 6月24日早上 7:22 左右热更新了工作台前端版本，从 `web_19.5.0` → `web_19.20.0`。

#### 错误来源

新版本的 JS 文件 `common.1a7b75ff.js?t=20260623163924` 在 630行 43417列 处抛出：
```
Uncaught TypeError: m is not a function
```

#### 发送失败链路

1. 拼多多页面 `common.1a7b75ff.js` 抛出 `m is not a function`
2. Bridge runtime 的 `window.addEventListener('error')` 全局监听捕获到该错误 → 发送 `window-error` diagnostic
3. `waitForPddSendOutcome()` 监听到 `window-error` → 直接判定发送失败（`ok: false`）

### 问题本质

`waitForPddSendOutcome` 中 `window-error` 的判定粒度太粗——拼多多页面自身偶然抛出的 JS 错误被误判为发送失败。

涉及代码位置：
- `main/chat-handlers.js` 第 72-78 行：`waitForPddSendOutcome` 中的 `window-error` 处理
- `main/pdd-bridge-runtime.js` 第 1232-1239 行：bridge 全局 `window.onerror` 监听

### 优化方向（待实施）

`window-error` 不应直接判定发送失败，应改为：
1. 如果已收到 `pdd-send-callback`，以 callback 结果为准
2. 如果未收到 callback，`window-error` 触发重试而非直接判失败

### 补充发现

- CDP 连接有大量 `ECONNREFUSED` 错误，说明原生发送路径（`Runtime.evaluate`）经常不可用
- 很多 `pdd-send-callback` 的 sample 为 undefined，说明 `sendMsg` 回调不稳定

---

## 2026-06-25：适配 web_19.20.0 socketUtil.sendMsg 新签名

### 问题根因

拼多多从 `web_19.5.0` 升级到 `web_19.20.0` 后，`window.socketUtil.sendMsg` 的调用方式发生了变化。Bridge runtime 使用的是旧的三参数形式 `sendMsg(uid, content, callback)`，而新版本需要对象参数形式。

CDP 路径（`pdd-manager.js`）一直使用的是对象参数形式，所以 CDP 路径不受影响，只有 WebSocket bridge 路径受影响。

### 改动 1：bridge runtime sendMsg 命令处理

**文件**：`main/pdd-bridge-runtime.js` 第 890-912 行

**改前**（三参数调用）：
```js
window.socketUtil.sendMsg(uid, content, callback);
```

**改后**（对象参数调用，与 CDP 路径一致）：
```js
window.socketUtil.sendMsg({
  content: content,
  uid: uid,
  csid: csid,
  type: 0,
  cb: callback
});
```

`csid` 获取优先级：`command.csid` → `window.global_uid` → `localStorage.currentUid`

### 改动 2：bridge runtime autoOrderMessage 发送

**文件**：`main/pdd-bridge-runtime.js` 第 838 行

**改前**：
```js
window.socketUtil.sendMsg(buyerUid, text, resolve);
```

**改后**：
```js
window.socketUtil.sendMsg({
  content: text,
  uid: buyerUid,
  csid: csid,
  type: 0,
  cb: resolve
});
```

### 改动 3：window-error 不再误判发送失败

**文件**：`main/chat-handlers.js` 第 72-78 行

**改前**：`window-error` 直接判定 `ok: false`，导致发送失败
**改后**：`window-error` 不再干预发送结果，仅保留诊断上报。发送结果完全由 `pdd-send-callback` 决定，超时未收到 callback 由 `setTimeout` 自然返回 `null`

---

## 2026-06-25：图片消息支持传给 tmagent

### 问题背景

客户发图片消息时，图片消息被完全跳过（`kind !== 'text'`），不会触发自动回复，图片 URL 也没有传给 tmagent。需要让图片消息也能触发自动回复，并将图片 URL 传给 AI 处理。

### 改动 1：放开图片消息的 kind 限制

**文件**：`main/chat-handlers.js` 第 351 行

**改前**：
```js
if (!message || message.direction !== 'user' || message.kind !== 'text') {
  return { skipped: true, reason: 'not-buyer-text' };
}
```

**改后**：
```js
if (!message || message.direction !== 'user' || (message.kind !== 'text' && message.kind !== 'image')) {
  return { skipped: true, reason: 'not-buyer-text' };
}
```

### 改动 2：defaultMessageType 增加 image 映射

**文件**：`main/tmagent-client.js` 第 17-21 行

**改前**：
```js
function defaultMessageType(kind) {
  if (kind === 'goods') return 'product_card';
  if (kind === 'order') return 'order_card';
  return 'text';
}
```

**改后**：
```js
function defaultMessageType(kind) {
  if (kind === 'goods') return 'product_card';
  if (kind === 'order') return 'order_card';
  if (kind === 'image') return 'image';
  return 'text';
}
```

### 改动 3：image_source 传图片 URL

**文件**：`main/tmagent-client.js` 第 59 行

**改前**：
```js
image_source: null,
```

**改后**：
```js
image_source: message.kind === 'image' ? String(message.content?.url || '') : null,
```

### 注意事项

- 图片消息的 `message.content` 结构为 `{ url, thumb }`，没有 `text` 字段，所以传给 tmagent 的 `message` 字段为空字符串，tmagent 端需通过 `image_source` 字段获取图片 URL
- `message_type` 字段对图片消息会变为 `'image'`，tmagent 端需要能识别此类型
- 文本消息行为保持不变

## 2026-06-25：修复 shop_id 未上传给 tmagent 的问题

### 问题现象

tmagent 服务端反馈没有收到 `shop_id`，导致无法按店铺维度做配置/统计。

### 根因

`main/chat-handlers.js` 第 420 行构造 `tmagentShopId` 时，取值优先级为：
```js
const tmagentShopId = tmagent.shopId || aiSettings.tenantId || process.env.PDD_FUKE_TMAGENT_SHOP_ID;
```
完全没有使用 `payload?.client?.shopId`（即 bridge runtime 通过 `currentCsr` 事件上报的实际店铺 ID），导致 shop_id 要么是配置里的固定值，要么回退到 `'default'`。

### 数据链路（正常情况）

1. `pdd-bridge-runtime.js` 的 `emitCurrentCsr` 从 `user.mall_id` 取到 `shopId`，通过 `currentCsr` 事件上报
2. `websocket.js` 的 `applyCurrentCsr` 把 `shopId` 存入 `client.shopId`
3. `chat-handlers.js` 处理消息时从 `payload.client.shopId` 取到该值
4. 传给 `buildTmagentChatPayload` → tmagent `shop_id` 字段

### 改动

`main/chat-handlers.js`：

**改前**：
```js
const tmagentShopId = tmagent.shopId || aiSettings.tenantId || process.env.PDD_FUKE_TMAGENT_SHOP_ID;
const tmagentShopName = tmagent.shopName || aiSettings.merchantName || process.env.PDD_FUKE_TMAGENT_SHOP_NAME;
```

**改后**：
```js
const tmagentShopId = payload?.client?.shopId
  || tmagent.shopId
  || aiSettings.tenantId
  || process.env.PDD_FUKE_TMAGENT_SHOP_ID;
const tmagentShopName = payload?.client?.shopName
  || tmagent.shopName
  || aiSettings.merchantName
  || process.env.PDD_FUKE_TMAGENT_SHOP_NAME;
```

### 优先级说明

1. **bridge 实际检测到的店铺 ID**（`payload.client.shopId`）——最准确，反映当前登录账号
2. 调用方显式传入的 `tmagent.shopId`
3. AI 配置里的 `aiSettings.tenantId`
4. 环境变量 `PDD_FUKE_TMAGENT_SHOP_ID`
5. 兜底 `'default'`（在 `buildTmagentChatPayload` 内）

shop_name 同理，优先用实际上报的店铺名。
