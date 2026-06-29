'use strict';

const { EventEmitter } = require('node:events');
const util = require('node:util');
const { WebSocketServer } = require('ws');
const msgpack = require('@msgpack/msgpack');
const { parsePddMessages, parseQnMessages, parseProtocolMessage } = require('./message-parser');

const noopLogger = { log() {}, error() {} };

function parseClientInfo(requestUrl, host, fallbackHost, fallbackPort) {
  const url = new URL(requestUrl || '/', `ws://${host || `${fallbackHost}:${fallbackPort}`}`);
  const route = url.pathname.replace(/^\/+|\/+$/g, '');
  const routePlatform = route === 'publicplatform' ? 'publicplatform' : '';

  return {
    platform: routePlatform || url.searchParams.get('platform') || 'pdd',
    csrName: url.searchParams.get('csrName') || '',
    targetId: url.searchParams.get('targetId') || ''
  };
}

function sampleValue(value) {
  if (typeof value === 'string') return value.substring(0, 500);
  return util.inspect(value, { depth: 6, breakLength: Infinity }).substring(0, 1000);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function updateClientFromProtocol(client, protocol) {
  const payload = protocol?.payload || {};
  const mall = payload.mall && typeof payload.mall === 'object' ? payload.mall : {};
  const shopName = firstText(
    payload.shopName,
    payload.storeName,
    payload.mallName,
    payload.merchantName,
    mall.mall_name,
    mall.name
  );
  const shopId = firstText(payload.shopId, payload.shop_id, payload.mallId, payload.mall_id, mall.mall_id, mall.id);
  const csrName = firstText(payload.csrName, payload.userName, payload.username, payload.nick, payload.name);
  if (shopName) client.shopName = shopName;
  if (shopId) client.shopId = shopId;
  if (csrName) client.csrName = csrName;
}

class InternalWebSocketServer extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 0, heartbeatIntervalMs = 30000, logger = noopLogger } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.wss = null;
    this.heartbeatTimer = null;
    this.clients = new Map();
  }

  async start() {
    if (this.wss) return this.address();

    this.wss = new WebSocketServer({ host: this.host, port: this.port });

    this.wss.on('connection', (socket, request) => {
      const info = parseClientInfo(request.url, request.headers.host, this.host, this.port);
      const client = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        platform: info.platform,
        csrName: info.csrName,
        targetId: info.targetId,
        url: request.url || '',
        remoteAddress: request.socket?.remoteAddress || '',
        userAgent: request.headers['user-agent'] || '',
        socket,
        alive: true,
        encoding: 'json',
        targetIds: new Set([info.targetId].filter(Boolean)),
        connectedAt: Date.now()
      };

      this.clients.set(client.id, client);
      this.logger.log('[ws:client-connected]', this.publicClient(client));
      this.emit('client-connected', this.publicClient(client));
      if (client.platform === 'publicplatform' || client.platform === 'pdd') {
        this.send(client.id, { act: 'getCurrentCsr' });
      }

      socket.on('pong', () => {
        client.alive = true;
      });

      socket.on('message', (buffer) => {
        this.handleMessage(client, buffer);
      });

      socket.on('close', () => {
        this.clients.delete(client.id);
        this.logger.log('[ws:client-disconnected]', this.publicClient(client));
        this.emit('client-disconnected', this.publicClient(client));
      });

      socket.on('error', (error) => {
        this.logger.error('[ws:client-error]', error);
        this.emit('client-error', { client: this.publicClient(client), error: error.message });
      });
    });

    await new Promise((resolve) => this.wss.once('listening', resolve));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.logger.log('[ws:start]', this.address());
    this.emit('listening', this.address());
    return this.address();
  }

  address() {
    if (!this.wss) return null;
    const address = this.wss.address();
    return typeof address === 'object' && address ? address : null;
  }

  publicClient(client) {
    return {
      id: client.id,
      platform: client.platform,
      shopId: client.shopId,
      shopName: client.shopName,
      storeName: client.storeName,
      csrName: client.csrName,
      targetId: client.targetId,
      url: client.url,
      remoteAddress: client.remoteAddress,
      userAgent: client.userAgent,
      connectedAt: client.connectedAt
    };
  }

  publicClients() {
    return Array.from(this.clients.values()).map((client) => this.publicClient(client));
  }

  decodeMessage(client, raw) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const text = buffer.toString();

    let envelope;
    try {
      envelope = JSON.parse(text);
      return { envelope, rawText: text, encoding: 'json' };
    } catch {
      try {
        envelope = msgpack.decode(new Uint8Array(buffer));
        client.encoding = 'msgpack';
        return { envelope, rawText: '[msgpack]', encoding: 'msgpack', sample: sampleValue(envelope) };
      } catch {
        return { envelope: text, rawText: text, encoding: 'text', sample: text.substring(0, 500) };
      }
    }
  }

  handleMessage(client, raw) {
    const { envelope, rawText, encoding, sample } = this.decodeMessage(client, raw);
    this.logger?.log?.('[ws:message-received]', { client: client.id, encoding, raw: rawText.substring(0, 200), sample });

    if (envelope && typeof envelope === 'object' && envelope.type === 'diagnostic' && envelope.source === 'pdd-bridge') {
      const diagnostic = {
        source: envelope.source,
        name: String(envelope.name || ''),
        payload: envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {},
        time: envelope.time || Date.now()
      };
      this.logger?.log?.('[bridge:diagnostic]', {
        client: client.id,
        name: diagnostic.name,
        payload: diagnostic.payload
      });
      this.emit('bridge-diagnostic', {
        client: this.publicClient(client),
        diagnostic
      });
      return;
    }

    if (envelope && typeof envelope === 'object' && String(envelope.type).toLowerCase() === 'heartbeat') {
      this.send(client.id, { type: 'heartbeat', act: 'pong', param: { time: Date.now() } });
      return;
    }

    const protocol = parseProtocolMessage(envelope);
    if (protocol) {
      updateClientFromProtocol(client, protocol);
      this.logger?.log?.('[ws:protocol-message-parsed]', {
        client: client.id,
        type: protocol.type,
        requestId: protocol.requestId,
        sessionId: protocol.sessionId
      });
      this.emit('protocol-message', {
        client: this.publicClient(client),
        protocol
      });
      this.emit(`${protocol.type}-message`, {
        client: this.publicClient(client),
        protocol
      });
      return;
    }

    const parsedMessages = client.platform === 'qn' ? parseQnMessages(envelope) : parsePddMessages(envelope);
    if (parsedMessages.length > 0) {
      for (const parsed of parsedMessages) {
        if (!client.targetId && parsed.conversationId !== 'unknown') {
          client.targetId = parsed.conversationId;
        }
        if (parsed.conversationId !== 'unknown') {
          client.targetIds.add(parsed.conversationId);
        }

        const logPayload = {
          client: client.id,
          platform: client.platform,
          conversationId: parsed.conversationId,
          senderName: parsed.senderName,
          senderId: parsed.senderId,
          direction: parsed.direction,
          kind: parsed.kind,
          messageType: parsed.messageType,
          typeCode: parsed.typeCode,
          msgId: parsed.id,
          timestamp: parsed.timestamp,
          textSample: parsed.content?.text,
          cardKeys: parsed.card ? Object.keys(parsed.card).filter((key) => parsed.card[key] !== undefined && parsed.card[key] !== null && parsed.card[key] !== '') : []
        };
        this.logger?.log?.(client.platform === 'qn' ? '[ws:qn-message-parsed]' : '[ws:pdd-message-parsed]', logPayload);
        this.emit('pdd-message', {
          client: this.publicClient(client),
          message: parsed
        });
      }
      return;
    }

    this.logger?.log?.('[ws:raw-message-unparsed]', {
      client: client.id,
      raw: rawText.substring(0, 200),
      sample
    });
    this.emit('raw-message', { client: this.publicClient(client), raw: envelope });
  }

  send(clientId, payload) {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== client.socket.OPEN) {
      this.logger?.log?.('[ws:send-skip]', { clientId, reason: client ? 'socket-not-open' : 'client-not-found' });
      return false;
    }
    this.logger?.log?.('[ws:send]', {
      clientId,
      type: payload?.type,
      act: payload?.act,
      targetId: payload?.param?.targetId
    });
    if (client.encoding === 'msgpack') {
      client.socket.send(msgpack.encode(payload));
    } else {
      client.socket.send(JSON.stringify(payload));
    }
    return true;
  }

  sendToTarget(targetId, payload) {
    let sent = 0;
    for (const client of this.clients.values()) {
      if (!targetId || client.targetId === targetId || client.targetIds?.has(targetId)) {
        if (this.send(client.id, payload)) sent += 1;
      }
    }
    return sent;
  }

  heartbeat() {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client.id);
        this.emit('client-disconnected', this.publicClient(client));
        continue;
      }
      client.alive = false;
      client.socket.ping();
      if (client.platform !== 'qn') {
        this.send(client.id, { type: 'heartbeat', act: 'ping', param: { time: Date.now() } });
      }
    }
  }

  close() {
    if (this.wss) this.logger.log('[ws:stop]', this.address());

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    if (this.wss) {
      for (const client of this.clients.values()) {
        client.socket.close();
      }
      this.wss.close();
    }

    this.clients.clear();
    this.wss = null;
  }
}

module.exports = {
  InternalWebSocketServer
};
