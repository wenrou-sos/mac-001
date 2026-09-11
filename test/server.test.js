import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// server.js 顶层即建店并读 DATA_DIR，必须在导入前指定隔离目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-server-'));
process.env.DATA_DIR = TMP;
process.env.PORT = '0';

const { server, store, parseLimit } = await import('../src/server.js');

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const FRONT = {
  'X-Role': 'FRONT', 'X-User-Name': 'lin', 'X-User-Id': 'u-front',
  'Content-Type': 'application/json',
};

function jsonGet(p) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${p}`, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    }).on('error', reject);
  });
}

function post(roomId, payload, headers = FRONT) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(`${BASE}/api/rooms/${roomId}/transitions`, {
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

// 以 Last-Event-ID 打开 SSE，收集 ms 毫秒内的帧；返回解析后的 hello 与 transition 事件
function openSSE({ lastEventId = '', ms = 600 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const req = http.get(`${BASE}/api/events`, { headers }, (res) => {
      let buf = '';
      const frames = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let id = '', event = '', data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          frames.push({ id, event, data: data ? JSON.parse(data) : null });
        }
      });
      setTimeout(() => { req.destroy(); resolve(frames); }, ms);
    });
    req.on('error', reject);
  });
}

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// 建一个只有种子事件的独立包厢，避免与种子房间 / 其他用例共享状态
function addRoom(id, action = 'CHECK_IN', from = 'OPEN', to = 'IN_USE') {
  store.rooms.set(id, { id, name: id });
  store.events.set(id, [{
    id: `${id}-seed`, roomId: id, action,
    fromState: from, toState: to,
    operatorId: 'u-front', operatorName: 'lin', operatorRole: 'FRONT',
    toResponsibleId: 'u-front', toResponsible: 'lin', reason: null,
    idempotencyKey: null,
    // 早于真实运行时间，使该房间事件顺序为 seed < 后续 HTTP 提交
    at: new Date(800_000_000_000).toISOString(), version: 1,
  }]);
  store._rebuildRoomFromEvents(id, { touch: false });
}

test('parseLimit：无效/非整数/小于 1 回退默认，有效值钳制到 1..200', () => {
  assert.equal(parseLimit('abc'), 50);
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit(''), 50);
  assert.equal(parseLimit('-5'), 50);
  assert.equal(parseLimit('0'), 50);
  assert.equal(parseLimit('1.5'), 50);
  assert.equal(parseLimit('NaN'), 50);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('100'), 100);
  assert.equal(parseLimit('200'), 200);
  assert.equal(parseLimit('201'), 200);
  assert.equal(parseLimit('999999'), 200);
  // 自定义默认/上限
  assert.equal(parseLimit('0', 30, 100), 30);
  assert.equal(parseLimit('500', 30, 100), 100);
});

test('history 接口：非法 limit 不返回全量，负数不错位截取，最大 200 条', async () => {
  // 直接注入 205 条内存事件（路由读 store，无需落盘）
  store.rooms.set('RBIG', { id: 'RBIG', name: 'RBIG' });
  store.events.set('RBIG', Array.from({ length: 205 }, (_, i) => ({
    id: `ev-RBIG-${i + 1}`, roomId: 'RBIG', action: 'CHECK_IN',
    fromState: 'OPEN', toState: 'IN_USE',
    operatorId: 'u-front', operatorName: 'lin', operatorRole: 'FRONT',
    toResponsibleId: 'u-front', toResponsible: 'lin', reason: null,
    idempotencyKey: null, at: new Date(1_000_000_000_000 + i * 1000).toISOString(),
    version: i + 1,
  })));
  store._rebuildRoomFromEvents('RBIG', { touch: false });

  const abc = await jsonGet('/api/rooms/RBIG/history?limit=abc');
  assert.equal(abc.status, 200);
  assert.equal(abc.body.events.length, 50); // 回退默认，而非全量 205
  assert.equal(abc.body.events[0].version, 205); // 仍为最近记录倒序

  const neg = await jsonGet('/api/rooms/RBIG/history?limit=-5');
  assert.equal(neg.body.events.length, 50);
  assert.equal(neg.body.events[0].version, 205);

  const float = await jsonGet('/api/rooms/RBIG/history?limit=1.5');
  assert.equal(float.body.events.length, 50);

  const huge = await jsonGet('/api/rooms/RBIG/history?limit=999999');
  assert.equal(huge.body.events.length, 200); // 硬上限
  assert.equal(huge.body.events[0].version, 205);

  const small = await jsonGet('/api/rooms/RBIG/history?limit=3');
  assert.deepEqual(small.body.events.map((e) => e.version), [205, 204, 203]);

  const def = await jsonGet('/api/rooms/RBIG/history');
  assert.equal(def.body.events.length, 50);
});

test('SSE 建连窗口竞态：补齐读取期间提交的流转必达（hello 或实时帧至少一次）', async () => {
  const roomId = 'RACE';
  addRoom(roomId); // v1：OPEN→IN_USE
  const orig = store.recentEvents.bind(store);
  let injected = null;
  let frames;
  // 模拟「服务端读取完补齐事件、客户端尚未注册到订阅集合」的窗口：
  // recentEvents 返回后立刻以同步方式提交一次流转（修复后客户端此刻已注册并在缓冲）
  store.recentEvents = (opts) => {
    const result = orig(opts);
    if (!injected) {
      injected = store._commitLocked(
        roomId,
        { action: 'CHECK_OUT', expectedVersion: 1, reason: null, idempotencyKey: 'race-key-1' },
        { id: 'u-front', name: 'lin', role: 'FRONT' },
      );
    }
    return result;
  };
  try {
    frames = await openSSE({ ms: 600 });
  } finally {
    store.recentEvents = orig;
  }

  const helloFrames = frames.filter((f) => f.event === 'hello');
  assert.equal(helloFrames.length, 1);
  const hello = helloFrames[0].data;
  const inFeed = hello.feed.some((e) => e.id === injected.event.id);
  const pushed = frames
    .filter((f) => f.event === 'transition')
    .map((f) => f.data.event.id);
  const pushedOk = pushed.includes(injected.event.id);
  assert.ok(inFeed || pushedOk, '窗口内流转既不在补齐结果也未实时推送');
  // hello 必须排在所有实时帧之前
  assert.equal(frames.findIndex((f) => f.event === 'hello'), 0);
});

test('SSE 重连：带 Last-Event-ID 只补齐其后的事件', async () => {
  const roomId = 'RGAP';
  addRoom(roomId); // v1：OPEN→IN_USE
  const r1 = await post(roomId, {
    action: 'CHECK_OUT', expectedVersion: 1, idempotencyKey: 'gap-a',
  });
  assert.equal(r1.status, 200);
  const r2 = await post(roomId, {
    action: 'CLAIM', expectedVersion: 2, idempotencyKey: 'gap-b',
  }, { ...FRONT, 'X-Role': 'CLEANER', 'X-User-Id': 'u-clean', 'X-User-Name': 'wang' });
  assert.equal(r2.status, 200);

  // 只收到 r1 后断线：重连 hello 只包含 r2
  const frames = await openSSE({ lastEventId: r1.body.event.id, ms: 300 });
  const hello = frames.find((f) => f.event === 'hello').data;
  assert.ok(!hello.feed.some((e) => e.id === r1.body.event.id));
  assert.ok(hello.feed.some((e) => e.id === r2.body.event.id));
});

test('SSE 正常连接时实时流转照常推送', async () => {
  const roomId = 'RLIVE';
  addRoom(roomId, 'CHECK_OUT', 'IN_USE', 'TO_CLEAN'); // v1：待清洁，可接单
  const framesP = openSSE({ ms: 800 });
  await new Promise((r) => setTimeout(r, 200));
  const r = await post(roomId, { action: 'CLAIM', expectedVersion: 1, idempotencyKey: 'live-1' },
    { ...FRONT, 'X-Role': 'CLEANER', 'X-User-Id': 'u-clean2', 'X-User-Name': 'li' });
  assert.equal(r.status, 200);
  const frames = await framesP;
  const ids = frames.filter((f) => f.event === 'transition').map((f) => f.data.event.id);
  assert.ok(ids.includes(r.body.event.id));
});
