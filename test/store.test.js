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
