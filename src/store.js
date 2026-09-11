// 包厢状态同步核心领域逻辑：有限状态机 + 交接事件 + 乐观锁 + SLA 预警
import fs from 'node:fs';
import path from 'node:path';

export const STATE = {
  IN_USE: 'IN_USE',       // 使用中
  TO_CLEAN: 'TO_CLEAN',   // 待清洁
  CLEANING: 'CLEANING',   // 清洁中
  INSPECTING: 'INSPECTING', // 检查中
  OPEN: 'OPEN',           // 可开放
};

export const STATE_LABEL = {
  IN_USE: '使用中',
  TO_CLEAN: '待清洁',
  CLEANING: '清洁中',
  INSPECTING: '检查中',
  OPEN: '可开放',
};

export const ACTION = {
  CHECK_IN: 'CHECK_IN',
  CHECK_OUT: 'CHECK_OUT',
  CLAIM: 'CLAIM',
  RELEASE_CLAIM: 'RELEASE_CLAIM',
  SUBMIT_CLEAN: 'SUBMIT_CLEAN',
  PASS_INSPECTION: 'PASS_INSPECTION',
  REJECT_INSPECTION: 'REJECT_INSPECTION',
  ROLLBACK: 'ROLLBACK',
};

export const ACTION_LABEL = {
  CHECK_IN: '开房',
  CHECK_OUT: '退房',
  CLAIM: '接单清洁',
  RELEASE_CLAIM: '放弃接单',
  SUBMIT_CLEAN: '清洁报检',
  PASS_INSPECTION: '检查通过',
  REJECT_INSPECTION: '检查不通过',
  ROLLBACK: '异常退回',
};

export const ROLE = {
  FRONT: 'FRONT',     // 前台
  CLEANER: 'CLEANER', // 保洁
  MANAGER: 'MANAGER', // 值班经理
};

export const ROLE_LABEL = { FRONT: '前台', CLEANER: '保洁', MANAGER: '值班经理' };

// 各动作允许的角色
const ACTION_ROLES = {
  CHECK_IN: [ROLE.FRONT],
  CHECK_OUT: [ROLE.FRONT],
  CLAIM: [ROLE.CLEANER],
  RELEASE_CLAIM: [ROLE.CLEANER, ROLE.MANAGER],
  SUBMIT_CLEAN: [ROLE.CLEANER],
  PASS_INSPECTION: [ROLE.MANAGER],
  REJECT_INSPECTION: [ROLE.MANAGER],
  ROLLBACK: [ROLE.MANAGER],
};

// 正常流转：动作 -> [起始状态, 目标状态]
const FLOW = {
  CHECK_IN: [STATE.OPEN, STATE.IN_USE],
  CHECK_OUT: [STATE.IN_USE, STATE.TO_CLEAN],
  CLAIM: [STATE.TO_CLEAN, STATE.CLEANING],
  RELEASE_CLAIM: [STATE.CLEANING, STATE.TO_CLEAN],
  SUBMIT_CLEAN: [STATE.CLEANING, STATE.INSPECTING],
  PASS_INSPECTION: [STATE.INSPECTING, STATE.OPEN],
  REJECT_INSPECTION: [STATE.INSPECTING, STATE.CLEANING],
};

// 需要强制填写原因的动作
const REASON_REQUIRED = new Set([ACTION.REJECT_INSPECTION, ACTION.ROLLBACK]);

// 每个状态当前阶段的责任人由事件上的哪些字段承载
function responsibleFor(ev) {
  if (!ev) return null;
  return { userId: ev.toResponsibleId, name: ev.toResponsible };
}

export class DomainError extends Error {
  constructor(message, status = 400, code = 'DOMAIN_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function slaFromEnv() {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    [STATE.TO_CLEAN]: num(process.env.SLA_CLAIM_SECONDS, 120),
    [STATE.CLEANING]: num(process.env.SLA_CLEAN_SECONDS, 300),
    [STATE.INSPECTING]: num(process.env.SLA_INSPECT_SECONDS, 180),
  };
}

// ---- 纯函数：计算动作目标状态（ROLLBACK 依赖历史） ----
// 异常退回的目标状态：最近一次非 ROLLBACK 流转发生之前的状态
export function rollbackTarget(currentState, events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].action !== ACTION.ROLLBACK) {
      const prev = events[i].fromState;
      if (!prev) throw new DomainError('该包厢初始即此状态，无可退回的上一步');
      // 不允许借退回跨越关键业务节点
      if (prev === STATE.OPEN && currentState !== STATE.INSPECTING) {
        throw new DomainError('已开放包厢只能在检查环节退回，不允许跨节点退回');
      }
      return prev;
    }
  }
  throw new DomainError('该包厢初始即此状态，无可退回的上一步');
}

export function nextState(action, currentState, events) {
  if (action === ACTION.ROLLBACK) return rollbackTarget(currentState, events);
  const [from, to] = FLOW[action];
  if (!from) throw new DomainError(`未知动作: ${action}`);
  if (currentState !== from) {
    throw new DomainError(`当前状态「${STATE_LABEL[currentState]}」不允许执行「${ACTION_LABEL[action]}」`);
  }
  return to;
}

// 每个状态可执行的动作（不依赖历史；ROLLBACK 是否真正可执行需结合历史判断）
export function allowedActions(state, role) {
  const result = [];
  for (const action of Object.keys(FLOW)) {
    if (FLOW[action][0] === state && ACTION_ROLES[action].includes(role)) result.push(action);
  }
  if (role === ROLE.MANAGER) result.push(ACTION.ROLLBACK);
  return result;
}

// ROLLBACK 是否会产生实际的状态流转（目标状态与当前不同且可回退）
export function canRollback(currentState, events) {
  try {
    return rollbackTarget(currentState, events) !== currentState;
  } catch {
    return false;
  }
}

export class RoomStore {
  constructor({ dir = './data', now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    this.sla = slaFromEnv();
    fs.mkdirSync(dir, { recursive: true });
    this.rooms = new Map();       // id -> room
    this.events = new Map();      // id -> event[]
    this.idempotency = new Map(); // key -> {roomId, event}
    this.locks = new Map();       // roomId -> Promise 链（串行化同包厢写入）
    this.alerts = new Map();      // `${roomId}:${state}` -> alert
    this.listeners = new Set();
    this._load();
  }

  _file() {
    return path.join(this.dir, 'events-db.json');
  }

  _load() {
    const f = this._file();
    if (!fs.existsSync(f)) return;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const r of data.rooms || []) {
        this.rooms.set(r.id, { ...r });
        this.events.set(r.id, []);
      }
      for (const ev of data.events || []) {
        this.events.get(ev.roomId)?.push(ev);
      }
      for (const [id] of this.rooms) this._rebuildRoomFromEvents(id, { touch: false });
      // 重建幂等键索引：事件顺序即首次提交顺序，保留最早一次结果（first-wins），
      // 否则服务重启后的同键重试会因内存索引丢失而重复执行流转
      for (const evs of this.events.values()) {
        for (const ev of evs) {
          if (ev.idempotencyKey && !this.idempotency.has(ev.idempotencyKey)) {
            this.idempotency.set(ev.idempotencyKey, { roomId: ev.roomId, event: ev });
          }
        }
      }
      for (const [k, v] of Object.entries(data.alerts || {})) this.alerts.set(k, { ...v });
    } catch (e) {
      console.error('加载数据失败，使用空数据启动:', e.message);
    }
  }

  _persist() {
    const data = {
      rooms: [...this.rooms.values()].map(({ id, name }) => ({ id, name })),
      events: [...this.events.values()].flat(),
      alerts: Object.fromEntries(this.alerts),
    };
    const tmp = this._file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this._file());
  }

  seedIfEmpty(rooms) {
    if (this.rooms.size > 0) return;
    for (const r of rooms) {
      this.rooms.set(r.id, { id: r.id, name: r.name });
      this.events.set(r.id, []);
    }
    for (const r of rooms) {
      const [action, fromState, toState, offsetSec, operatorName] = r.seed;
      const t = this.now() - offsetSec * 1000;
      let operatorRole = ROLE.FRONT;
      if (action === ACTION.CLAIM) operatorRole = ROLE.CLEANER;
      if (action === ACTION.SUBMIT_CLEAN) operatorRole = ROLE.CLEANER;
      let toResponsible = operatorName;
      let toResponsibleId = `seed-${r.id}`;
      if (action === ACTION.SUBMIT_CLEAN) {
        toResponsible = '值班经理';
        toResponsibleId = 'manager-on-duty';
      }
      this.events.get(r.id).push({
        id: `${r.id}-seed`,
        roomId: r.id,
        action,
        fromState,
        toState,
        operatorId: `seed-${r.id}`,
        operatorName,
        operatorRole,
        toResponsibleId,
        toResponsible,
        reason: null,
        idempotencyKey: null,
        at: new Date(t).toISOString(),
        version: 1,
      });
    }
    for (const [id] of this.rooms) this._rebuildRoomFromEvents(id, { touch: false });
    this._persist();
  }

  _rebuildRoomFromEvents(roomId, { touch = true } = {}) {
    const evs = this.events.get(roomId) || [];
    const room = this.rooms.get(roomId);
    if (!room) return;
    const last = evs[evs.length - 1];
    if (!last) {
      room.state = STATE.OPEN;
      room.version = 0;
      room.responsible = null;
    } else {
      room.state = last.toState;
      room.version = last.version;
      room.responsible = responsibleFor(last);
      room.updatedBy = last.operatorName;
    }
    room.since = last ? last.at : null;
    if (touch) room.updatedAt = new Date(this.now()).toISOString();
    else room.updatedAt = last ? last.at : null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.listeners) {
      try { fn(type, payload); } catch (e) { console.error('listener error', e); }
    }
  }

  // 同包厢写入串行化，消除读-改-写竞态
  async _withLock(roomId, fn) {
    const prev = this.locks.get(roomId) || Promise.resolve();
    let release;
    const next = new Promise((res) => { release = res; });
    this.locks.set(roomId, prev.then(() => next));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(roomId) === next) this.locks.delete(roomId);
    }
  }

  snapshot() {
    return {
      now: new Date(this.now()).toISOString(),
      sla: this.sla,
      rooms: [...this.rooms.values()].map((r) => ({ ...r })),
      alerts: [...this.alerts.values()],
    };
  }

  history(roomId, limit = 50) {
    const room = this.rooms.get(roomId);
    if (!room) throw new DomainError('包厢不存在', 404, 'NOT_FOUND');
    const evs = this.events.get(roomId) || [];
    return evs.slice(-limit).reverse();
  }

  // 结合该包厢历史计算某角色当前实际可执行的动作；
  // 纯状态机给经理始终展示 ROLLBACK，但退回目标等于当前状态时（如已退回到清洁中）必须收敛
  actionsForRoom(roomId, role) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return allowedActions(room.state, role)
      .filter((a) => a !== ACTION.ROLLBACK || canRollback(room.state, this.events.get(roomId) || []));
  }

  /**
   * 执行一次状态流转
   * @param {string} roomId
   * @param {object} op {action, expectedVersion, reason, idempotencyKey}
   * @param {object} operator {id, name, role}
   */
  async commitTransition(roomId, op, operator) {
    return this._withLock(roomId, () => this._commitLocked(roomId, op, operator));
  }

  _commitLocked(roomId, op, operator) {
    const room = this.rooms.get(roomId);
    if (!room) throw new DomainError('包厢不存在', 404, 'NOT_FOUND');
    const { action, expectedVersion, reason = null } = op;
    const idemKey = op.idempotencyKey || null;

    // 幂等：相同 key 直接返回首次结果
    if (idemKey) {
      const cached = this.idempotency.get(idemKey);
      if (cached && cached.roomId === roomId) {
        return { event: cached.event, duplicated: true };
      }
    }

    if (!operator?.id || !operator?.name || !ROLE[operator.role]) {
      throw new DomainError('操作人信息不完整', 401, 'UNAUTHORIZED');
    }
    if (!ACTION[action]) throw new DomainError(`未知动作: ${action}`);
    if (!ACTION_ROLES[action].includes(operator.role)) {
      throw new DomainError(`${ROLE_LABEL[operator.role]}无权执行「${ACTION_LABEL[action]}」`, 403, 'FORBIDDEN');
    }
    if (typeof expectedVersion !== 'number') {
      throw new DomainError('缺少 expectedVersion', 409, 'VERSION_CONFLICT');
    }
    if (expectedVersion !== room.version) {
      throw new DomainError(
        `状态已被其他人更新（你基于 v${expectedVersion}，当前 v${room.version}），请刷新后重试`,
        409, 'VERSION_CONFLICT',
      );
    }
    if (REASON_REQUIRED.has(action) && (!reason || !String(reason).trim())) {
      throw new DomainError(`「${ACTION_LABEL[action]}」必须填写原因`);
    }
    // 保洁只能放弃自己的接单（值班经理可强制收回）
    if (action === ACTION.RELEASE_CLAIM && operator.role === ROLE.CLEANER) {
      const claim = [...(this.events.get(roomId) || [])].reverse()
        .find((e) => e.action === ACTION.CLAIM);
      if (claim && claim.operatorId !== operator.id) {
        throw new DomainError('只能放弃自己接的清洁单', 403, 'FORBIDDEN');
      }
    }

    const evs = this.events.get(roomId);
    const fromState = room.state;
    const toState = nextState(action, fromState, evs);
    // 防御无效退回：退回到当前状态只会空转一个版本并刷新 SLA 计时，不允许写入
    if (action === ACTION.ROLLBACK && toState === fromState) {
      throw new DomainError('当前已是退回后的状态，不能对同一异常重复退回');
    }

    let toResponsible = operator.name;
    let toResponsibleId = operator.id;
    if (action === ACTION.CHECK_OUT) {
      // 待清洁阶段：等待保洁接单，责任暂挂前台
      toResponsible = operator.name;
    } else if (action === ACTION.SUBMIT_CLEAN) {
      toResponsible = '值班经理'; // 检查责任人角色，具体经理检查时确定
      toResponsibleId = 'manager-on-duty';
    } else if (action === ACTION.REJECT_INSPECTION) {
      // 退回原保洁返工：取历史上最近一次接单的保洁
      let claim = null;
      for (const e of evs) if (e.action === ACTION.CLAIM) claim = e;
      toResponsible = claim ? claim.operatorName : '原保洁';
      toResponsibleId = claim ? claim.operatorId : null;
    } else if (action === ACTION.ROLLBACK) {
      // 恢复为目标状态当时的责任人：找到建立该状态的事件
      const anchor = [...evs].reverse().find((e) => e.action !== ACTION.ROLLBACK);
      const established = [...evs].reverse().find((e) => e.toState === toState && e.action !== ACTION.ROLLBACK);
      toResponsible = established?.toResponsible || anchor?.toResponsible || operator.name;
      toResponsibleId = established?.toResponsibleId || operator.id;
    }

    const event = {
      id: `ev-${roomId}-${room.version + 1}-${this.now().toString(36)}`,
      roomId,
      action,
      fromState,
      toState,
      operatorId: operator.id,
      operatorName: operator.name,
      operatorRole: operator.role,
      toResponsibleId,
      toResponsible,
      reason: reason ? String(reason).trim() : null,
      idempotencyKey: idemKey,
      at: new Date(this.now()).toISOString(),
      version: room.version + 1,
    };
    evs.push(event);
    this._rebuildRoomFromEvents(roomId);
    if (idemKey) this.idempotency.set(idemKey, { roomId, event });

    // 流转后清除本包厢旧预警（tick 会按新状态重新评估）
    for (const key of [...this.alerts.keys()]) {
      if (key.startsWith(`${roomId}:`)) this.alerts.delete(key);
    }

    this._persist();
    this._emit('transition', { event, room: { ...room } });
    this._evaluateAlerts(true);
    return { event, duplicated: false };
  }

  _alertKey(roomId, state) {
    return `${roomId}:${state}`;
  }

  // 返回本轮产生/升级/消除的变化，供广播
  tickAlerts() {
    return this._evaluateAlerts(false);
  }

  _evaluateAlerts(transitionJustHappened) {
    const changes = [];
    const activeKeys = new Set();
    for (const room of this.rooms.values()) {
      const limit = this.sla[room.state];
      if (!limit || !room.since) continue;
      const key = this._alertKey(room.id, room.state);
      activeKeys.add(key);
      const elapsed = (this.now() - new Date(room.since).getTime()) / 1000;
      if (elapsed < limit) continue;

      const existing = this.alerts.get(key);
      const overdueSec = Math.round(elapsed - limit);
      if (!existing) {
        const alert = {
          key,
          roomId: room.id,
          roomName: room.name,
          state: room.state,
          level: elapsed >= limit * 2 ? 'CRITICAL' : 'WARNING',
          limitSec: limit,
          overdueSec,
          responsible: room.responsible,
          since: room.since,
          raisedAt: new Date(this.now()).toISOString(),
        };
        this.alerts.set(key, alert);
        changes.push({ type: 'raised', alert });
      } else {
        const level = elapsed >= limit * 2 ? 'CRITICAL' : 'WARNING';
        if (level !== existing.level || overdueSec !== existing.overdueSec) {
          const updated = { ...existing, level, overdueSec, responsible: room.responsible };
          this.alerts.set(key, updated);
          if (level !== existing.level) changes.push({ type: 'escalated', alert: updated });
        }
      }
    }
    // 状态已变化/已恢复的预警自动消除
    for (const key of [...this.alerts.keys()]) {
      if (!activeKeys.has(key)) {
        const alert = this.alerts.get(key);
        this.alerts.delete(key);
        changes.push({ type: 'resolved', alert });
      }
    }
    if (changes.length) this._emit('alerts', { changes, snapshot: this.snapshot().alerts });
    return changes;
  }
}
