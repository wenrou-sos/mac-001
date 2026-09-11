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
const { ACTION } = await import('../src/store.js');

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

test('预警确认 HTTP：前台 403、经理确认成功并经 alerts SSE 广播', async () => {
  // 直接构造一个进行中预警
  store.alerts.set('RAL:TO_CLEAN', {
    key: 'RAL:TO_CLEAN', status: 'ACTIVE', roomId: 'RAL', roomName: 'RAL',
    state: 'TO_CLEAN', level: 'CRITICAL', limitSec: 1, overdueSec: 10,
    responsible: { userId: 'uf', name: 'lin' }, since: new Date(Date.now() - 60000).toISOString(),
    raisedAt: new Date().toISOString(), note: null,
    acknowledgedById: null, acknowledgedByName: null, acknowledgedAt: null,
  });

  const forbidden = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ note: 'x' });
    const req = http.request(`${BASE}/api/alerts/RAL%3ATO_CLEAN/ack`, {
      method: 'POST',
      headers: { ...FRONT, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d)})); });
    req.on('error', reject); req.end(data);
  });
  assert.equal(forbidden.status, 403);

  const framesP = openSSE({ ms: 700 });
  await new Promise(r => setTimeout(r, 200));
  const ok = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ note: '已通知保洁' });
    const req = http.request(`${BASE}/api/alerts/RAL%3ATO_CLEAN/ack`, {
      method: 'POST',
      headers: { 'X-Role':'MANAGER','X-User-Name':'zhao','X-User-Id':'um','Content-Type':'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d)})); });
    req.on('error', reject); req.end(data);
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.alert.status, 'ACKNOWLEDGED');

  const frames = await framesP;
  const ackChange = frames.filter(f => f.event === 'alerts')
    .flatMap(f => f.data.changes).find(c => c.type === 'acknowledged');
  assert.ok(ackChange, '确认事件应通过 alerts SSE 广播');
  assert.equal(ackChange.alert.note, '已通知保洁');
  assert.equal(ackChange.alert.statusLabel, '处理中');
});

test('交接记录 HTTP：游标分页稳定、筛选生效、非法参数 400', async () => {
  // 注入 45 条事件
  const evs = Array.from({ length: 45 }, (_, i) => ({
    id: `RH-ev-${i+1}`, roomId: 'RH',
    action: i % 2 ? ACTION.CLAIM : ACTION.CHECK_IN,
    fromState: 'OPEN', toState: 'IN_USE',
    operatorId: i % 3 === 0 ? 'u-clean' : 'u-front',
    operatorName: i % 3 === 0 ? '保洁-王姐' : '前台-小林',
    operatorRole: i % 3 === 0 ? 'CLEANER' : 'FRONT',
    toResponsibleId: 'x', toResponsible: 'x', reason: null,
    idempotencyKey: null, at: new Date(1_100_000_000_000 + i * 1000).toISOString(), version: i + 1,
  }));
  store.rooms.set('RH', { id: 'RH', name: 'RH' });
  store.events.set('RH', evs);
  store._rebuildRoomFromEvents('RH', { touch: false });

  const p1 = await jsonGet('/api/rooms/RH/history?limit=20');
  assert.equal(p1.body.events.length, 20);
  assert.equal(p1.body.events[0].version, 45);
  assert.equal(p1.body.hasMore, true);
  assert.ok(p1.body.nextCursor);
  assert.equal(p1.body.totalMatched, 45);
  // 装饰字段
  assert.ok(p1.body.events[0].actionLabel);
  assert.equal(p1.body.filters.action, null);

  // 翻页期间注入 5 条更高版本事件：游标页不受影响
  for (let v = 46; v <= 50; v++) {
    store.events.get('RH').push({
      ...evs[0], id: `RH-ev-${v}`, version: v,
      at: new Date(1_100_000_046_000 + v * 1000).toISOString(),
    });
  }
  const p2 = await jsonGet(`/api/rooms/RH/history?limit=20&cursor=${p1.body.nextCursor}`);
  assert.deepEqual(p2.body.events.map(e => e.version).slice(0, 5), [25,24,23,22,21]);
  assert.equal(p2.body.events.length, 20);
  const p3 = await jsonGet(`/api/rooms/RH/history?limit=20&cursor=${p2.body.nextCursor}`);
  assert.deepEqual(p3.body.events.map(e => e.version), [5,4,3,2,1]);
  assert.equal(p3.body.hasMore, false);
  assert.equal(p3.body.nextCursor, null);

  // 动作筛选
  const onlyClaim = await jsonGet('/api/rooms/RH/history?action=CLAIM');
  assert.ok(onlyClaim.body.events.every(e => e.action === 'CLAIM'));

  // 操作人模糊 + 回显筛选条件
  const byOp = await jsonGet(`/api/rooms/RH/history?operator=${encodeURIComponent('王姐')}`);
  assert.ok(byOp.body.events.every(e => e.operatorName.includes('王姐')));
  assert.equal(byOp.body.filters.operator, '王姐');

  // 非法参数
  assert.equal((await jsonGet('/api/rooms/RH/history?action=NOPE')).status, 400);
  assert.equal((await jsonGet('/api/rooms/RH/history?cursor=bad')).status, 400);
  assert.equal((await jsonGet('/api/rooms/RH/history?from=zzz')).status, 400);
});

test('已解除预警历史 HTTP：按包厢过滤、带状态标签', async () => {
  store.resolvedAlerts.unshift({
    key: 'RRH:TO_CLEAN', status: 'RESOLVED', roomId: 'RRH', roomName: 'RRH',
    state: 'TO_CLEAN', level: 'WARNING', limitSec: 120, overdueSec: 5,
    responsible: null, since: new Date().toISOString(), raisedAt: new Date().toISOString(),
    note: '备注', acknowledgedById: 'um', acknowledgedByName: '老赵',
    acknowledgedAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
    resolveReason: 'state_change', resolvedByEventId: 'ev-1',
  });
  const r = await jsonGet('/api/alerts/history?roomId=RRH');
  assert.equal(r.body.alerts.length, 1);
  assert.equal(r.body.alerts[0].statusLabel, '已解除');
  assert.equal(r.body.alerts[0].acknowledgedByName, '老赵');
});
