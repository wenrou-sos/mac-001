// HTTP 服务：REST + SSE 实时推送，零依赖
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RoomStore, DomainError, STATE, ACTION, ROLE,
  STATE_LABEL, ACTION_LABEL, ROLE_LABEL, allowedActions,
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const store = new RoomStore({ dir: DATA_DIR });

// 演示包厢：最后一个参数为初始化事件（动作, 起始, 目标, 距现在秒数, 责任人）
// 306/307/308 的停留时间超过 demo SLA，启动即产生预警
store.seedIfEmpty([
  { id: 'R301', name: '301（中包）', seed: [ACTION.CHECK_IN, STATE.OPEN, STATE.IN_USE, 1800, '前台-小林'] },
  { id: 'R302', name: '302（小包）', seed: [ACTION.CHECK_IN, STATE.OPEN, STATE.IN_USE, 4200, '前台-小林'] },
  { id: 'R303', name: '303（大包）', seed: [ACTION.CHECK_OUT, STATE.IN_USE, STATE.TO_CLEAN, 60, '前台-阿珍'] },
  { id: 'R304', name: '304（中包）', seed: [ACTION.CHECK_OUT, STATE.IN_USE, STATE.TO_CLEAN, 200, '前台-阿珍'] },
  { id: 'R305', name: '305（豪包）', seed: [ACTION.CLAIM, STATE.TO_CLEAN, STATE.CLEANING, 120, '保洁-王姐'] },
  { id: 'R306', name: '306（中包）', seed: [ACTION.CHECK_OUT, STATE.IN_USE, STATE.TO_CLEAN, 600, '前台-小林'] },
  { id: 'R307', name: '307（小包）', seed: [ACTION.CLAIM, STATE.TO_CLEAN, STATE.CLEANING, 700, '保洁-李姐'] },
  { id: 'R308', name: '308（大包）', seed: [ACTION.SUBMIT_CLEAN, STATE.CLEANING, STATE.INSPECTING, 400, '保洁-王姐'] },
]);

// 给快照补充当前角色可做动作（前端按自身角色取用）
function decorateSnapshot(snap) {
  for (const room of snap.rooms) {
    room.allowedByRole = {
      [ROLE.FRONT]: allowedActions(room.state, ROLE.FRONT),
      [ROLE.CLEANER]: allowedActions(room.state, ROLE.CLEANER),
      [ROLE.MANAGER]: allowedActions(room.state, ROLE.MANAGER),
    };
    room.stateLabel = STATE_LABEL[room.state];
  }
  return snap;
}

// ---- SSE 客户端 ----
const sseClients = new Set();
store.subscribe((type, payload) => {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* 由 close 清理 */ }
  }
});
// 定期扫描 SLA（每 15s）
const TICK_MS = 15_000;
setInterval(() => {
  try { store.tickAlerts(); } catch (e) { console.error('tick error', e); }
}, TICK_MS);
setTimeout(() => store.tickAlerts(), 500);

// ---- HTTP 工具 ----
function sendJson(res, status, body) {
  const buf = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(buf),
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new DomainError('请求体过大', 413));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new DomainError('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function operatorFromReq(req) {
  // 演示鉴权：前端带头；生产环境改为解析会话/JWT。
  // 中文名兼容 percent-encoded（Node fetch 不允许非 Latin-1 头，浏览器原生 fetch 可直发 UTF-8）
  const decode = (v) => {
    try { return decodeURIComponent(v); } catch { return v; }
  };
  return {
    id: String(req.headers['x-user-id'] || ''),
    name: decode(String(req.headers['x-user-name'] || '')),
    role: String(req.headers['x-role'] || ''),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(__dirname, '..', 'public', rel));
  const pub = path.normalize(path.join(__dirname, '..', 'public'));
  if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/rooms') {
      return sendJson(res, 200, decorateSnapshot(store.snapshot()));
    }

    if (req.method === 'GET' && /^\/api\/rooms\/[^/]+\/history$/.test(p)) {
      const roomId = decodeURIComponent(p.split('/')[3]);
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const events = store.history(roomId, limit);
      return sendJson(res, 200, {
        roomId,
        events: events.map((e) => ({
          ...e,
          actionLabel: ACTION_LABEL[e.action],
          fromStateLabel: e.fromState ? STATE_LABEL[e.fromState] : null,
          toStateLabel: STATE_LABEL[e.toState],
          operatorRoleLabel: ROLE_LABEL[e.operatorRole],
        })),
      });
    }

    if (req.method === 'POST' && /^\/api\/rooms\/[^/]+\/transitions$/.test(p)) {
      const roomId = decodeURIComponent(p.split('/')[3]);
      const body = await readBody(req);
      const headerKey = req.headers['idempotency-key'];
      const result = await store.commitTransition(
        roomId,
        { ...body, idempotencyKey: body.idempotencyKey || (headerKey ? String(headerKey) : null) },
        operatorFromReq(req),
      );
      return sendJson(res, 200, { ok: true, duplicated: result.duplicated, event: result.event });
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify(decorateSnapshot(store.snapshot()))}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 30_000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, p);

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof DomainError) {
      return sendJson(res, e.status, { error: e.message, code: e.code });
    }
    console.error(e);
    sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log(`KTV 包厢状态看板: http://localhost:${PORT}`);
});
