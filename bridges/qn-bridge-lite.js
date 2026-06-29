(function () {
  'use strict';

  var bridgeName = 'qn-bridge-lite';
  var socket = null;
  var pendingByCcode = Object.create(null);
  var seen = Object.create(null);

  function textOf(value) {
    return value == null ? '' : String(value);
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  function log(message, extra) {
    try {
      console.log('[' + bridgeName + '] ' + message, extra || '');
    } catch (_) {}
    send('logs', {
      type: 'info',
      message: '[' + bridgeName + '] ' + message + (extra ? ' ' + safeJson(extra).slice(0, 500) : '')
    });
  }

  function send(type, msg, param, saveMessages) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    var envelope = { type: type, msg: msg, param: param || null };
    if (Array.isArray(saveMessages)) envelope.saveMessages = saveMessages;
    socket.send(JSON.stringify(envelope));
    return true;
  }

  function stableKey(raw) {
    if (!raw) return '';
    var mcode = raw.mcode || {};
    return textOf(mcode.clientId || mcode.messageId || raw.stableKey || raw.msgid || raw.messageId);
  }

  function targetOf(value) {
    if (!value) return '';
    if (typeof value === 'object') return textOf(value.targetId);
    return '';
  }

  function nickOf(value) {
    if (!value) return '';
    if (typeof value === 'object') return textOf(value.nick);
    return textOf(value);
  }

  function normalizeMessage(raw, apiChatUri) {
    if (!raw || typeof raw !== 'object') return null;
    var key = stableKey(raw);
    return {
      stableKey: key,
      fromid: nickOf(raw.fromid),
      fromidTargetId: targetOf(raw.fromid) || textOf(raw.fromidTargetId),
      loginid: nickOf(raw.loginid),
      loginidTargetId: targetOf(raw.loginid) || textOf(raw.loginidTargetId),
      toid: nickOf(raw.toid),
      toidTargetId: targetOf(raw.toid) || textOf(raw.toidTargetId),
      msg: raw.originalData || raw.msg || {},
      msgid: key,
      messageId: textOf((raw.mcode && raw.mcode.messageId) || raw.messageId),
      msgtime: textOf(raw.sendTime || raw.msgtime || raw.svrtime || Date.now()),
      svrtime: textOf(raw.sendTime || raw.svrtime || raw.msgtime || Date.now()),
      ext: raw.ext || {},
      extLocal: raw.extLocal || {},
      selfState: raw.selfState,
      source: raw.source,
      templateId: raw.templateId || (raw.mcode && raw.mcode.templateId),
      apiChatUri: apiChatUri || raw.apiChatUri || ''
    };
  }

  function isAssistant(item) {
    if (!item) return false;
    if (item.extLocal && item.extLocal.LocalSendMsg === 'SendByThisDev') return true;
    if (Number(item.selfState) === 1) return true;
    return Boolean(item.fromidTargetId && item.loginidTargetId && item.fromidTargetId === item.loginidTargetId);
  }

  function remember(ccode, rawItems) {
    if (!ccode || !Array.isArray(rawItems)) return;
    var current = pendingByCcode[ccode] || [];
    pendingByCcode[ccode] = current.concat(rawItems).slice(-50);
  }

  function emitMessages(type, ccode, rawItems, apiChatUri) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) return;
    var normalized = [];
    for (var i = 0; i < rawItems.length; i += 1) {
      var item = normalizeMessage(rawItems[i], apiChatUri);
      if (!item) continue;
      var key = item.stableKey || item.msgid || item.messageId;
      if (key && seen[key]) continue;
      if (key) seen[key] = true;
      normalized.push(item);
    }
    if (normalized.length === 0) return;
    send(type, normalized, ccode ? { ccode: ccode } : null, normalized);
  }

  function peekAndEmit(ccode, mode) {
    if (!ccode || !window.imsdk || typeof window.imsdk.invoke !== 'function') return Promise.resolve();
    return window.imsdk.invoke('im.singlemsg.PeekNewMsg', { ccode: ccode }).then(function (result) {
      var items = result && result.code === 0 && Array.isArray(result.result) ? result.result : [];
      if (items.length === 0 && pendingByCcode[ccode]) items = pendingByCcode[ccode].splice(0);
      if (items.length === 0) return;
      var filtered = mode === 'assistant'
        ? items.filter(function (item) { return isAssistant(normalizeMessage(item)); })
        : items.filter(function (item) { return !isAssistant(normalizeMessage(item)); });
      emitMessages(mode === 'assistant' ? 'newMsg' : 'message', ccode, filtered);
    }).catch(function (error) {
      log('peek failed', { ccode: ccode, message: error && error.message });
    });
  }

  function installReceivers() {
    if (window.__pddFukeQnLiteInstalled) return;
    window.__pddFukeQnLiteInstalled = true;

    if (window.imsdk && typeof window.imsdk.on === 'function') {
      window.imsdk.on(['im.singlemsg.onReceiveNewMsg'], function (event) {
        var ccode = event && event[0] && event[0].ccode;
        log('event onReceiveNewMsg', { ccode: ccode });
        peekAndEmit(ccode, 'user');
      });

      window.imsdk.on(['im.singlemsg.onMsgSendUpdate'], function (event) {
        var ccode = event && event[0] && event[0].cid && event[0].cid.ccode;
        log('event onMsgSendUpdate', { ccode: ccode });
        peekAndEmit(ccode, 'assistant');
      });
    }

    if (window.imsdk2 && typeof window.imsdk2.getNewMsg === 'function' && !window.__pddFukeQnLiteGetNewMsg) {
      window.__pddFukeQnLiteGetNewMsg = window.imsdk2.getNewMsg;
      window.imsdk2.getNewMsg = function (cid, options) {
        return window.__pddFukeQnLiteGetNewMsg.call(this, cid, options).then(function (items) {
          var ccode = cid && cid.ccode;
          if (Array.isArray(items) && items.length > 0) {
            remember(ccode, items);
            emitMessages('message', ccode, items);
            var assistantItems = items.filter(function (item) { return isAssistant(normalizeMessage(item)); });
            emitMessages('newMsg', ccode, assistantItems);
          }
          return items;
        });
      };
    }

    log('receivers installed');
  }

  function openConversation(command) {
    var id = textOf(command && (command.id || command.targetId));
    var customerName = textOf(command && (command.customerName || command.buyerNick || command.nick));
    if (!customerName) {
      send('switchConversationResult', { success: false, ccode: id, customerName: customerName, reason: 'customerName missing' });
      return;
    }
    var nick = /^cntaobao/.test(customerName) ? customerName : 'cntaobao' + customerName;
    log('switchConversation', { ccode: id, customerName: customerName });
    try {
      var result = window.imsdk.invoke('application.openChat', { nick: nick });
      Promise.resolve(result).then(function (value) {
        send('switchConversationResult', { success: true, ccode: id, customerName: customerName, result: value || null });
      }).catch(function (error) {
        send('switchConversationResult', { success: false, ccode: id, customerName: customerName, reason: error && error.message || String(error) });
      });
    } catch (error) {
      send('switchConversationResult', { success: false, ccode: id, customerName: customerName, reason: error && error.message || String(error) });
    }
  }

  function sendText(command) {
    var param = command && command.param || {};
    var ccode = textOf(param.ccode || param.userid || command.id || command.targetId);
    var text = textOf(param.msg || param.text || command.text);
    if (!ccode || !text) {
      log('send skipped', { reason: 'missing ccode/text', ccode: ccode, textLength: text.length });
      send('logs', { type: 'error', message: '[' + bridgeName + '] send skipped missing ccode/text' });
      return;
    }
    log('send enter', { route: 'send_text_message', ccode: ccode, textLength: text.length });
    var payload = { ccode: ccode, text: text };
    try {
      if (typeof window.NativeCall === 'function') {
        Promise.resolve(window.NativeCall('send_text_message', payload)).then(function (result) {
          var code = textOf(result && result.code);
          var success = code === '0';
          log('send callback', {
            route: 'send_text_message',
            ccode: ccode,
            statusLabel: success ? 'success' : 'failed',
            code: code,
            message: result && result.message || ''
          });
        }).catch(function (error) {
          log('send failed', { route: 'send_text_message', ccode: ccode, message: error && error.message || String(error) });
        });
        return;
      }

      log('send failed', { route: 'send_text_message', ccode: ccode, message: 'NativeCall unavailable' });
    } catch (error) {
      log('send exception', { ccode: ccode, message: error && error.message || String(error) });
    }
  }

  function handleCommand(raw) {
    var command;
    try {
      command = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      log('command parse failed', { message: error && error.message });
      return;
    }
    var act = command && command.act;
    if (!act) return;
    log('command received', { act: act });
    if (act === 'switchConversation') openConversation(command);
    else if (act === 'sendMsg' || act === 'sendtext') sendText(command);
    else if (act === 'ping') send('heartbeat', { time: Date.now() });
  }

  function connect() {
    var port = window.js_data;
    if (!port) {
      console.warn('[' + bridgeName + '] missing window.js_data');
      return;
    }
    var url = 'ws://127.0.0.1:' + port + '?platform=qn&bridge=lite';
    socket = new WebSocket(url);
    socket.addEventListener('open', function () {
      log('connected', { url: url });
      installReceivers();
      if (window.imsdk && typeof window.imsdk.invoke === 'function') {
        window.imsdk.invoke('im.login.GetCurrentLoginID', {}).then(function (result) {
          send('currentCsr', result && result.result ? Object.assign({}, result.result, { platform: 'qn-lite' }) : result);
        }).catch(function (error) {
          log('current csr failed', { message: error && error.message });
        });
      }
    });
    socket.addEventListener('message', function (event) {
      handleCommand(event.data);
    });
    socket.addEventListener('close', function () {
      console.log('[' + bridgeName + '] websocket closed');
      setTimeout(connect, 2000);
    });
    socket.addEventListener('error', function () {
      console.log('[' + bridgeName + '] websocket error');
    });
  }

  connect();
})();
