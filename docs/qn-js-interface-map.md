# QN JS interface map

Date: 2026-06-23

Purpose: record the QN bridge interfaces extracted from the current working Fuke JS behavior, then implement our own minimal bridge without copying the large bundled script.

## Core data path

```text
QN client
  -> injected JS bridge
  -> local WebSocket platform=qn
  -> Electron websocket parser
  -> tmagent auto reply
  -> local WebSocket command
  -> injected JS bridge
  -> QN native send_text_message
  -> native callback
  -> outbound merchant newMsg
```

## WebSocket contract

- Connect to `ws://127.0.0.1:${window.js_data}?platform=qn`.
- Send message envelopes shaped like `{ type, msg, param }`.
- Receive app commands shaped like `{ act, param }`.
- Current parser expects inbound chat envelopes with `type: "message"` or `type: "newMsg"` and `msg: [...]`.

## Identity and session

- Current CSR: `imsdk.invoke("im.login.GetCurrentLoginID", {})`.
- Current conversation: `imsdk.invoke("im.uiutil.GetCurrentConversationID", {})`.
- Open chat: `imsdk.invoke("application.openChat", { nick: "cntaobao" + customerName })`.

## Receive interfaces

- Main foreground/background message read: wrap `imsdk2.getNewMsg(cid, options)`.
- Buyer arrival event: `imsdk.on(["im.singlemsg.onReceiveNewMsg"], handler)`.
- Merchant send update event: `imsdk.on(["im.singlemsg.onMsgSendUpdate"], handler)`.
- New message fetch after event: `imsdk.invoke("im.singlemsg.PeekNewMsg", { ccode })`.
- Remote history fallback: `imsdk.invoke("im.singlemsg.GetRemoteHisMsg", { cid: { appkey: "cntaobao", nick, ccode, type: 1 }, count, gohistory, msgid, msgtime })`.
- Local history fallback: `imsdk.invoke("im.singlemsg.GetLocalHisMsg", { cid: { appkey: "cntaobao", nick, ccode, type: 1 }, count })`.

## Message normalization

QN raw SDK messages use nested sender objects. The bridge should normalize them into fields already handled by `main/message-parser.js`:

- `stableKey`: `mcode.clientId` or `mcode.messageId`.
- `fromid`: `fromid.nick`.
- `fromidTargetId`: `fromid.targetId`.
- `loginid`: `loginid.nick`.
- `loginidTargetId`: `loginid.targetId`.
- `toid`: `toid.nick`.
- `toidTargetId`: `toid.targetId`.
- `msg`: `originalData`.
- `msgid`: same stable key.
- `messageId`: `mcode.messageId`.
- `msgtime` / `svrtime`: `sendTime`.
- `selfState`, `source`, `templateId`, `ext`, `extLocal`.

Direction is determined in Node by comparing `fromidTargetId` with `loginidTargetId`.

## Send interfaces

The confirmed successful route is:

```text
app auto-reply
  -> act=sendMsg
  -> JS route=NativeCall("send_text_message")
  -> native callback code=0
  -> statusLabel=成功
  -> outbound merchant newMsg
```

Command payloads should accept both forms:

```js
{ act: "sendMsg", param: { userid, ccode, msg } }
{ act: "sendtext", id, text }
```

Normalized native send parameters:

```js
window.NativeCall("send_text_message", {
  ccode: param.ccode || param.userid || command.id,
  text: param.msg || param.text || command.text
})
```

The bridge must log entry, route, callback success/failure, and text length. Full text should be logged only when needed for live debugging.

## Defer for later

These interfaces are useful but not required for the first self-owned bridge:

- `QN.app.invoke({ api: "invokeMTopChannelService", query: { method, param, httpMethod: "post", version } })`
- `mtop.taobao.qianniu.cs.trade.query`
- `mtop.taobao.qianniu.cs.item.detail.query`
- product sync, order export, forwarding, group transfer, customer search.

First target is receive + send + callback, not order/product enrichment.
