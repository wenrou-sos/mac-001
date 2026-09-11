import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RoomStore, DomainError, STATE, ACTION, ROLE, nextState, allowedActions, canRollback,
  FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT,
} from '../src/store.js';

const FRONT = { id: 'u-front', name: '前台-小林', role: ROLE.FRONT };
const CLEANER = { id: 'u-clean', name: '保洁-王姐', role: ROLE.CLEANER };
const CLEANER2 = { id: 'u-clean2', name: '保洁-李姐', role: ROLE.CLEANER };
const MANAGER = { id: 'u-mgr', name: '值班经理-老赵', role: ROLE.MANAGER };

let t = 0;
function clock() { return t; }
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-test-'));
}
function freshStore() {
  t = 1_000_000_000_000;
  const store = new RoomStore({ dir: tmpDir(), now: clock });
  store.rooms.set('R1', { id: 'R1', name: 'R1' });
  store.events.set('R1', []);
  store._rebuildRoomFromEvents('R1');
  return store;
}
async function run(store, action, op2 = {}, user = FRONT) {
  t += 1000;
  const roomId = op2.roomId || 'R1';
  const room = store.rooms.get(roomId);
  return store.commitTransition(
    roomId,
    { action, expectedVersion: room.version, reason: null, ...op2 },
    user,
  );
}

test('完整正常流转：OPEN→使用→待清洁→清洁→检查→开放', async () => {
  const s = freshStore();
  assert.equal(s.rooms.get('R1').state, STATE.OPEN);

  await run(s, ACTION.CHECK_IN, {}, FRONT);
  assert.equal(s.rooms.get('R1').state, STATE.IN_USE);
  assert.equal(s.rooms.get('R1').responsible.name, FRONT.name);

  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  assert.equal(s.rooms.get('R1').state, STATE.TO_CLEAN);

  await run(s, ACTION.CLAIM, {}, CLEANER);
  assert.equal(s.rooms.get('R1').state, STATE.CLEANING);
  assert.equal(s.rooms.get('R1').responsible.name, CLEANER.name);

  await run(s, ACTION.SUBMIT_CLEAN, {}, CLEANER);
  assert.equal(s.rooms.get('R1').state, STATE.INSPECTING);

  await run(s, ACTION.PASS_INSPECTION, {}, MANAGER);
  assert.equal(s.rooms.get('R1').state, STATE.OPEN);
  assert.equal(s.rooms.get('R1').version, 5);
  assert.equal(s.events.get('R1').length, 5);
});

test('非法流转被拒绝（可开放不能直接清洁）', async () => {
  const s = freshStore();
  await assert.rejects(
    run(s, ACTION.CLAIM, {}, CLEANER),
    (e) => e instanceof DomainError && e.status === 400,
  );
});

test('RBAC：保洁不能开房，前台不能检查', async () => {
  const s = freshStore();
  await assert.rejects(run(s, ACTION.CHECK_IN, {}, CLEANER), e => e.status === 403);
  await run(s, ACTION.CHECK_IN, {}, FRONT);
  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  await run(s, ACTION.CLAIM, {}, CLEANER);
  await run(s, ACTION.SUBMIT_CLEAN, {}, CLEANER);
  await assert.rejects(run(s, ACTION.PASS_INSPECTION, {}, FRONT), e => e.status === 403);
});

test('乐观锁：基于旧版本提交返回 409，且不产生事件', async () => {
  const s = freshStore();
  await run(s, ACTION.CHECK_IN, { expectedVersion: 0 }, FRONT);
  // 另一人已把房间推进到 v1，保洁仍基于 v0 接单
  await assert.rejects(
    run(s, ACTION.CLAIM, { expectedVersion: 0 }, CLEANER),
    (e) => e.status === 409 && e.code === 'VERSION_CONFLICT',
  );
  assert.equal(s.events.get('R1').length, 1);
});

test('并发同版本提交：只有一个成功，另一个 409', async () => {
  const s = freshStore();
  await run(s, ACTION.CHECK_IN, {}, FRONT);
  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  const v = s.rooms.get('R1').version;
  const results = await Promise.allSettled([
    s.commitTransition('R1', { action: ACTION.CLAIM, expectedVersion: v }, CLEANER),
    s.commitTransition('R1', { action: ACTION.CLAIM, expectedVersion: v }, CLEANER2),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(s.rooms.get('R1').version, v + 1);
});

test('幂等键：相同 Idempotency-Key 重试不重复记事件', async () => {
  const s = freshStore();
  const key = 'idem-abc-1';
  const r1 = await s.commitTransition('R1', { action: ACTION.CHECK_IN, expectedVersion: 0, idempotencyKey: key }, FRONT);
  assert.equal(r1.duplicated, false);
  // 即使带的是过期版本，幂等命中也直接返回首次结果
  const r2 = await s.commitTransition('R1', { action: ACTION.CHECK_IN, expectedVersion: 0, idempotencyKey: key }, FRONT);
  assert.equal(r2.duplicated, true);
  assert.equal(r2.event.id, r1.event.id);
  assert.equal(s.events.get('R1').length, 1);
});

test('检查不通过强制原因并退回原保洁返工', async () => {
  const s = freshStore();
  await run(s, ACTION.CHECK_IN, {}, FRONT);
  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  await run(s, ACTION.CLAIM, {}, CLEANER);
  await run(s, ACTION.SUBMIT_CLEAN, {}, CLEANER);
  await assert.rejects(run(s, ACTION.REJECT_INSPECTION, {}, MANAGER), /必须填写原因/);
  await run(s, ACTION.REJECT_INSPECTION, { reason: '地面有酒渍' }, MANAGER);
  assert.equal(s.rooms.get('R1').state, STATE.CLEANING);
  assert.equal(s.rooms.get('R1').responsible.name, CLEANER.name);
  const ev = s.events.get('R1').at(-1);
  assert.equal(ev.reason, '地面有酒渍');
});

test('异常退回：经理可退回上一状态并恢复责任人，前台无权', async () => {
  const s = freshStore();
  await run(s, ACTION.CHECK_IN, {}, FRONT);
  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  await run(s, ACTION.CLAIM, {}, CLEANER);
  await run(s, ACTION.SUBMIT_CLEAN, {}, CLEANER);
  // 检查中 → 退回清洁中
  await assert.rejects(run(s, ACTION.ROLLBACK, {}, FRONT), e => e.status === 403);
  await assert.rejects(run(s, ACTION.ROLLBACK, {}, MANAGER), /必须填写原因/);
  await run(s, ACTION.ROLLBACK, { reason: '保洁误报，实际未完成' }, MANAGER);
  assert.equal(s.rooms.get('R1').state, STATE.CLEANING);
  assert.equal(s.rooms.get('R1').responsible.name, CLEANER.name);
  const ev = s.events.get('R1').at(-1);
  assert.equal(ev.action, ACTION.ROLLBACK);
  assert.equal(ev.fromState, STATE.INSPECTING);
  assert.equal(ev.toState, STATE.CLEANING);
});

test('初始状态无历史可退回时拒绝', () => {
  assert.throws(() => nextState(ACTION.ROLLBACK, STATE.OPEN, []), /无可退回/);
});

test('SLA 超时：生成预警、升级严重、流转后消除', async () => {
  t = 1_000_000_000_000;
  const s = new RoomStore({ dir: tmpDir(), now: clock });
  s.rooms.set('R9', { id: 'R9', name: 'R9' });
  s.events.set('R9', []);
  s._rebuildRoomFromEvents('R9');
  await run(s, ACTION.CHECK_IN, { roomId: 'R9' }, FRONT);
  await run(s, ACTION.CHECK_OUT, { roomId: 'R9' }, FRONT); // TO_CLEAN，SLA 120s
  // 未超时
  t += 60_000;
  assert.deepEqual(s.tickAlerts().filter(c => c.type === 'raised'), []);
  // 超时
  t += 61_000; // 共 121s
  let changes = s.tickAlerts();
  let raised = changes.find(c => c.type === 'raised');
  assert.ok(raised);
  assert.equal(raised.alert.level, 'WARNING');
  // 2 倍阈值升级
  t += 130_000;
  changes = s.tickAlerts();
  assert.equal(changes.find(c => c.type === 'escalated')?.alert.level, 'CRITICAL');
  // 保洁接单，预警消除
  await run(s, ACTION.CLAIM, { roomId: 'R9' }, CLEANER);
  assert.ok(![...s.alerts.keys()].some(k => k.startsWith('R9:')));
});

test('放弃接单：保洁只能放弃自己的单，经理可强制收回', async () => {
  const s = freshStore();
  await run(s, ACTION.CHECK_IN, {}, FRONT);
  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  await run(s, ACTION.CLAIM, {}, CLEANER);
  await assert.rejects(run(s, ACTION.RELEASE_CLAIM, {}, CLEANER2), e => e.status === 403);
  await run(s, ACTION.RELEASE_CLAIM, {}, MANAGER);
  assert.equal(s.rooms.get('R1').state, STATE.TO_CLEAN);
});

test('allowedActions 按角色与状态收敛', () => {
  assert.deepEqual(allowedActions(STATE.OPEN, ROLE.FRONT), [ACTION.CHECK_IN]);
  assert.deepEqual(allowedActions(STATE.OPEN, ROLE.CLEANER), []);
  assert.ok(allowedActions(STATE.INSPECTING, ROLE.MANAGER).includes(ACTION.ROLLBACK));
  assert.ok(allowedActions(STATE.INSPECTING, ROLE.MANAGER).includes(ACTION.PASS_INSPECTION));
});

test('重启后事件可重建房间状态与版本', async () => {
  const dir = tmpDir();
  t = 1_000_000_000_000;
  const s1 = new RoomStore({ dir, now: clock });
  s1.rooms.set('R7', { id: 'R7', name: 'R7' });
  s1.events.set('R7', []);
  s1._rebuildRoomFromEvents('R7');
  await s1.commitTransition('R7', { action: ACTION.CHECK_IN, expectedVersion: 0 }, FRONT);

  const s2 = new RoomStore({ dir, now: clock });
  assert.equal(s2.rooms.get('R7').state, STATE.IN_USE);
  assert.equal(s2.rooms.get('R7').version, 1);
  // 基于重建后的版本可继续流转
  await s2.commitTransition('R7', { action: ACTION.CHECK_OUT, expectedVersion: 1 }, FRONT);
  assert.equal(s2.rooms.get('R7').state, STATE.TO_CLEAN);
});

test('重启后幂等键索引恢复：同键重试命中首次结果，不重复流转', async () => {
  const dir = tmpDir();
  t = 1_000_000_000_000;
  const s1 = new RoomStore({ dir, now: clock });
  s1.rooms.set('R8', { id: 'R8', name: 'R8' });
  s1.events.set('R8', []);
  s1._rebuildRoomFromEvents('R8');
  const key = 'idem-restart-1';
  const r1 = await s1.commitTransition(
    'R8', { action: ACTION.CHECK_IN, expectedVersion: 0, idempotencyKey: key }, FRONT,
  );
  assert.equal(r1.duplicated, false);

  // 模拟服务重启：网络请求实际已成功，客户端在重启后带相同键重试
  const s2 = new RoomStore({ dir, now: clock });
  const room = s2.rooms.get('R8');
  assert.equal(room.version, 1);
  const r2 = await s2.commitTransition(
    'R8', { action: ACTION.CHECK_IN, expectedVersion: 0, idempotencyKey: key }, FRONT,
  );
  assert.equal(r2.duplicated, true);
  assert.equal(r2.event.id, r1.event.id);
  assert.equal(s2.events.get('R8').length, 1);
  assert.equal(s2.rooms.get('R8').version, 1);
});

test('异常退回不能重复执行：退回清洁中后再次退回被拒绝且不写事件', async () => {

  const s = freshStore();
  await run(s, ACTION.CHECK_IN, {}, FRONT);
  await run(s, ACTION.CHECK_OUT, {}, FRONT);
  await run(s, ACTION.CLAIM, {}, CLEANER);
  await run(s, ACTION.SUBMIT_CLEAN, {}, CLEANER);
  await run(s, ACTION.ROLLBACK, { reason: '保洁误报，实际未完成' }, MANAGER);
  assert.equal(s.rooms.get('R1').state, STATE.CLEANING);
  const versionAfterRollback = s.rooms.get('R1').version;
  const eventsAfterRollback = s.events.get('R1').length;

  // 经理角色的动作列表中不再出现 ROLLBACK（前端不展示按钮）
  assert.ok(!s.actionsForRoom('R1', ROLE.MANAGER).includes(ACTION.ROLLBACK));
  assert.ok(!canRollback(STATE.CLEANING, s.events.get('R1')));
  // 检查中仍然可以退回
  assert.ok(canRollback(STATE.INSPECTING, s.events.get('R1').slice(0, 4)));

  // 绕过前端直接提交也必须被服务端拒绝：不产生 CLEANING→CLEANING 空转事件
  await assert.rejects(
    run(s, ACTION.ROLLBACK, { reason: '再点一次' }, MANAGER),
    (e) => e instanceof DomainError && /重复退回/.test(e.message),
  );
  assert.equal(s.events.get('R1').length, eventsAfterRollback);
  assert.equal(s.rooms.get('R1').version, versionAfterRollback);
  assert.equal(s.rooms.get('R1').state, STATE.CLEANING);
  // 进入清洁中的时间不应被第二次退回刷新
  assert.equal(s.rooms.get('R1').since, s.events.get('R1').at(-1).at);
});

function twoRoomStore() {
  t = 1_000_000_000_000;
  const s = new RoomStore({ dir: tmpDir(), now: clock });
  s.rooms.set('RA', { id: 'RA', name: 'RA' });
  s.rooms.set('RB', { id: 'RB', name: 'RB' });
  s.events.set('RA', []);
  s.events.set('RB', []);
  s._rebuildRoomFromEvents('RA');
  s._rebuildRoomFromEvents('RB');
  return s;
}

test('全局动态：跨包厢合并、按时间正序、受 limit 上限约束', async () => {
  const s = twoRoomStore();
  await run(s, ACTION.CHECK_IN, { roomId: 'RA' }, FRONT);        // t+1000
  await run(s, ACTION.CHECK_IN, { roomId: 'RB' }, FRONT);        // t+2000
  await run(s, ACTION.CHECK_OUT, { roomId: 'RA' }, FRONT);       // t+3000

  const feed = s.recentEvents();
  assert.deepEqual(feed.map(e => e.roomId), ['RA', 'RB', 'RA']);
  assert.ok(feed.every((e, i) => i === 0 || feed[i - 1].at <= e.at));

  const limited = s.recentEvents({ limit: 2 });
  assert.equal(limited.length, 2);
  assert.deepEqual(limited.map(e => e.roomId), ['RB', 'RA']);

  // 非法/越界 limit 归一化到默认与硬上限
  assert.equal(s.recentEvents({ limit: 0 }).length, 3);
  assert.equal(s.recentEvents({ limit: FEED_MAX_LIMIT + 999 }).length, 3);
});

test('全局动态：afterId 游标补齐断线期间事件，未知游标回退最近窗口', async () => {
  const s = twoRoomStore();
  const r1 = await run(s, ACTION.CHECK_IN, { roomId: 'RA' }, FRONT);
  const e2 = await run(s, ACTION.CHECK_IN, { roomId: 'RB' }, FRONT);
  const r3 = await run(s, ACTION.CHECK_OUT, { roomId: 'RA' }, FRONT);

  // 客户端只收到 r1，之后断线：补齐 r1 之后的事件（正序）
  const missed = s.recentEvents({ afterId: r1.event.id });
  assert.equal(missed.length, 2);
  assert.deepEqual(missed.map(e => e.id), [e2.event.id, r3.event.id]);
  assert.ok(!missed.some(e => e.id === r1.event.id));

  // 未知/过期游标（如服务重启后事件窗口外）：回退为最近 limit 条，由客户端按 id 去重
  const fallback = s.recentEvents({ afterId: 'ev-does-not-exist', limit: 2 });
  assert.equal(fallback.length, 2);
  assert.equal(fallback[fallback.length - 1].id, r3.event.id);
});

test('全局动态：重启后仍可从持久化事件加载最近动态', async () => {
  const dir = tmpDir();
  t = 1_000_000_000_000;
  const s1 = new RoomStore({ dir, now: clock });
  s1.rooms.set('RN', { id: 'RN', name: 'RN' });
  s1.events.set('RN', []);
  s1._rebuildRoomFromEvents('RN');
  await s1.commitTransition('RN', { action: ACTION.CHECK_IN, expectedVersion: 0 }, FRONT);

  const s2 = new RoomStore({ dir, now: clock });
  const feed = s2.recentEvents();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].action, ACTION.CHECK_IN);
  assert.equal(feed[0].roomId, 'RN');
});

// ---- 交接记录游标分页 + 筛选 ----
function eventRoom(store, id, count, actionSeq) {
  store.rooms.set(id, { id, name: id });
  const evs = Array.from({ length: count }, (_, i) => {
    const v = i + 1;
    const action = actionSeq ? actionSeq[i % actionSeq.length] : ACTION.CHECK_IN;
    return {
      id: `${id}-ev-${v}`, roomId: id, action,
      fromState: STATE.OPEN, toState: STATE.IN_USE,
      operatorId: i % 2 ? 'u-clean' : 'u-front',
      operatorName: i % 2 ? '保洁-王姐' : '前台-小林',
      operatorRole: i % 2 ? ROLE.CLEANER : ROLE.FRONT,
      toResponsibleId: 'x', toResponsible: 'x', reason: i % 3 ? null : '测试原因',
      idempotencyKey: null,
      at: new Date(1_000_000_000_000 + v * 1000).toISOString(), version: v,
    };
  });
  store.events.set(id, evs);
  store._rebuildRoomFromEvents(id, { touch: false });
  return evs;
}

test('queryHistory：时间倒序、游标稳定分页，翻页期间新事件不重复不跳过', () => {
  const s = freshStore();
  eventRoom(s, 'RP', 25);

  const p1 = s.queryHistory('RP', { limit: 10 });
  assert.deepEqual(p1.events.map(e => e.version), [25,24,23,22,21,20,19,18,17,16]);
  assert.equal(p1.totalMatched, 25);
  assert.ok(p1.nextCursor);

  // 翻页期间新增 3 个事件（只追加更高版本，不影响已发出的游标）
  const more = eventRoom(s, 'RP', 28).slice(-3);
  void more;

  const p2 = s.queryHistory('RP', { limit: 10, cursor: p1.nextCursor });
  assert.deepEqual(p2.events.map(e => e.version), [15,14,13,12,11,10,9,8,7,6]);
  const p3 = s.queryHistory('RP', { limit: 10, cursor: p2.nextCursor });
  assert.deepEqual(p3.events.map(e => e.version), [5,4,3,2,1]);
  assert.equal(p3.nextCursor, null); // 已到最早

  // 三页无重复无遗漏（新增的 26-28 不在旧页中，重新从首页查才能看到）
  const seen = [...p1.events, ...p2.events, ...p3.events].map(e => e.version);
  assert.equal(new Set(seen).size, 25);
  assert.deepEqual([...seen].sort((a,b)=>a-b), Array.from({length:25},(_,i)=>i+1));
});

test('queryHistory：动作/操作人/时间范围筛选与非法参数', () => {
  const s = freshStore();
  eventRoom(s, 'RF', 6, [ACTION.CHECK_IN, ACTION.CHECK_OUT]);

  const byAction = s.queryHistory('RF', { action: 'CHECK_IN' });
  assert.ok(byAction.events.every(e => e.action === ACTION.CHECK_IN));
  assert.equal(byAction.totalMatched, 3);

  const byActions = s.queryHistory('RF', { action: 'CHECK_IN,CHECK_OUT' });
  assert.equal(byActions.totalMatched, 6);

  const byName = s.queryHistory('RF', { operatorName: '王姐' });
  assert.ok(byName.events.every(e => e.operatorName.includes('王姐')));
  assert.equal(byName.totalMatched, 3);

  const byId = s.queryHistory('RF', { operatorId: 'u-front' });
  assert.ok(byId.events.every(e => e.operatorId === 'u-front'));

  // 时间范围：取第 2..4 条（at = base + v*1000）
  const ranged = s.queryHistory('RF', {
    from: new Date(1_000_000_001_500).toISOString(),
    to: new Date(1_000_000_004_500).toISOString(),
  });
  assert.deepEqual(ranged.events.map(e => e.version).sort((a,b)=>a-b), [2,3,4]);

  assert.throws(() => s.queryHistory('RF', { action: 'NOPE' }), /未知动作/);
  assert.throws(() => s.queryHistory('RF', { from: 'bad' }), /起始时间无效/);
  assert.throws(() => s.queryHistory('RF', { cursor: '!!!' }), /游标/);
  assert.throws(() => s.queryHistory('MISSING', {}), e => e.status === 404);
});

// ---- 预警确认与解除历史 ----
test('预警确认：仅经理可确认，确认信息保留至自动解除后的历史', async () => {
  const s = new RoomStore({ dir: tmpDir(), now: clock });
  s.rooms.set('RA', { id: 'RA', name: 'RA' });
  s.events.set('RA', []);
  s._rebuildRoomFromEvents('RA');
  await run(s, ACTION.CHECK_IN, { roomId: 'RA' }, FRONT);
  await run(s, ACTION.CHECK_OUT, { roomId: 'RA' }, FRONT); // TO_CLEAN

  t += 121_000;
  s.tickAlerts();
  const key = 'RA:TO_CLEAN';
  assert.ok(s.alerts.has(key));
  assert.equal(s.alerts.get(key).status, 'ACTIVE');

  // 前台/保洁无权确认
  assert.throws(() => s.acknowledgeAlert(key, '处理中', FRONT), e => e.status === 403);
  assert.throws(() => s.acknowledgeAlert(key, '处理中', CLEANER), e => e.status === 403);
  assert.throws(() => s.acknowledgeAlert(key, '  ', MANAGER), /处理备注/);

  const ack = s.acknowledgeAlert(key, '已联系保洁加急', MANAGER);
  assert.equal(ack.status, 'ACKNOWLEDGED');
  assert.equal(ack.acknowledgedByName, MANAGER.name);
  assert.equal(ack.note, '已联系保洁加急');
  assert.ok(ack.acknowledgedAt);

  // 已确认后仅更新备注，确认时间不变
  const firstAckAt = ack.acknowledgedAt;
  t += 10_000;
  const ack2 = s.acknowledgeAlert(key, '保洁已到场', MANAGER);
  assert.equal(ack2.note, '保洁已到场');
  assert.equal(ack2.acknowledgedAt, firstAckAt);

  assert.throws(() => s.acknowledgeAlert('RA:NOPE', 'x', MANAGER), e => e.status === 404);

  // 状态流转自动解除，确认信息进入历史
  await run(s, ACTION.CLAIM, { roomId: 'RA' }, CLEANER);
  assert.ok(!s.alerts.has(key));
  const histAlerts = s.alertHistory('RA');
  assert.equal(histAlerts.length, 1);
  assert.equal(histAlerts[0].status, 'RESOLVED');
  assert.equal(histAlerts[0].acknowledgedByName, MANAGER.name);
  assert.equal(histAlerts[0].note, '保洁已到场');
  assert.equal(histAlerts[0].resolveReason, 'state_change');
  assert.ok(histAlerts[0].resolvedByEventId);
});

test('已解除预警历史有上限（RESOLVED_ALERTS_MAX）', () => {
  const s = new RoomStore({ dir: tmpDir(), now: clock });
  for (let i = 0; i < 205; i++) {
    s.alerts.set(`R${i}:X`, { key: `R${i}:X`, roomId: `R${i}`, status: 'ACTIVE' });
    s._resolveRoomAlerts(`R${i}`, { reason: 'state_change' });
  }
  assert.equal(s.resolvedAlerts.length, 200);
});

test('预警确认状态持久化：重启后进行中预警仍为处理中，已解除记录保留', async () => {
  const dir = tmpDir();
  t = 1_000_000_000_000;
  const s1 = new RoomStore({ dir, now: clock });
  s1.rooms.set('RP', { id: 'RP', name: 'RP' });
  s1.events.set('RP', []);
  s1._rebuildRoomFromEvents('RP');
  await s1.commitTransition('RP', { action: ACTION.CHECK_IN, expectedVersion: 0 }, FRONT);
  await s1.commitTransition('RP', { action: ACTION.CHECK_OUT, expectedVersion: 1 }, FRONT);
  t += 121_000;
  s1.tickAlerts();
  s1.acknowledgeAlert('RP:TO_CLEAN', '跟进中', MANAGER);

  const s2 = new RoomStore({ dir, now: clock });
  const a = s2.alerts.get('RP:TO_CLEAN');
  assert.ok(a);
  assert.equal(a.status, 'ACKNOWLEDGED');
  assert.equal(a.note, '跟进中');
  assert.equal(a.acknowledgedByName, MANAGER.name);
});
