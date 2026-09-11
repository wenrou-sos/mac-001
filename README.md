# mac-001

KTV 包厢状态同步与交接系统

前台、保洁、值班经理共用的包厢状态看板。零依赖，Node.js 内置 HTTP + SSE（Server-Sent Events）实现实时同步。

## 解决的四个难点

### 1. 状态流转规则（有限状态机 + RBAC）

状态：`IN_USE` 使用中 → `TO_CLEAN` 待清洁 → `CLEANING` 清洁中 → `INSPECTING` 检查中 → `OPEN` 可开放（可回到 `IN_USE`）。

| 动作 | 起始 → 目标 | 谁能做 | 交接责任人 |
|---|---|---|---|
| CHECK_IN 开房 | OPEN → IN_USE | 前台 | 前台登记人 |
| CHECK_OUT 退房 | IN_USE → TO_CLEAN | 前台 | 前台登记人（待保洁接手） |
| CLAIM 接单清洁 | TO_CLEAN → CLEANING | 保洁 | 保洁 |
| RELEASE_CLAIM 放弃接单 | CLEANING → TO_CLEAN | 保洁（仅未超时/本人接单，或值班经理） | — |
| SUBMIT_CLEAN 报检 | CLEANING → INSPECTING | 保洁 | 值班经理（检查责任人） |
| PASS_INSPECTION 检查通过 | INSPECTING → OPEN | 值班经理 | — |
| REJECT_INSPECTION 检查不通过 | INSPECTING → CLEANING | 值班经理（必须填原因） | 原保洁 |
| ROLLBACK 异常退回 | 回退到上一状态（不允许跨过退房/报检） | 值班经理（必须填原因） | 恢复为该状态原责任人 |

非法流转（如 OPEN → CLEANING）直接 400 拒绝。规则全部集中在 `src/store.js` 的 `nextState()`，前端只按返回的 `allowedActions` 渲染按钮。

### 2. 多人同时修改冲突（乐观锁 + 幂等 + 串行化）

- 每个包厢带单调递增 `version`，每次流转 +1；客户端操作必须带 `expectedVersion`，过期即 **409**，要求刷新后重试（前端自动拉最新快照并弹提示）。
- 每个包厢一把内存互斥锁，同一包厢的写入串行化，杜绝读-改-写竞态（单进程够用；多实例部署见文末）。
- `Idempotency-Key` 头：网络重试时相同 key 返回第一次的结果，不会重复记交接。
- SSE 广播所有变更，所有人看板实时更新；`alerts` 事件推送超时预警。

### 3. 超时提醒（SLA 扫描 + 去重/升级/自动消除）

三段 SLA，可用环境变量调整（秒）：

| 状态 | 配置项 | 生产建议 | demo 默认 |
|---|---|---|---|
| TO_CLEAN 无人接单 | SLA_CLAIM_SECONDS | 300 | 120 |
| CLEANING 清洁未报检 | SLA_CLEAN_SECONDS | 900 | 300 |
| INSPECTING 未出结果 | SLA_INSPECT_SECONDS | 300 | 180 |

- 每 15s 扫描，超时生成预警并广播；到 2× 阈值升级为严重（红色），同一超时不重复打扰。
- 状态流转后对应预警自动消除；ROLLBACK 后按当前状态重新计时。

### 4. 异常状态退回（只允许回到上一状态，强制留痕）

`ROLLBACK` 仅值班经理可用，必须填写原因：从最近的交接记录恢复上一状态与原责任人，写入一条 `ROLLBACK` 事件（含原因和退回到哪一步）。不存在上一步（初始即该状态）时拒绝。
此外检查不通过 `REJECT_INSPECTION` 是最常见的业务退回，同样强制填原因，自动退回原保洁返工。

## 交接记录

每次状态流转追加一条不可变事件（`data/events-*.jsonl`），包含：动作、前后状态、操作人/角色、**from/to 责任人**、原因、时间、版本、幂等键。
`GET /api/rooms/:id/history?limit=` 查询；看板右侧实时显示。

## 运行

```bash
npm start                 # http://localhost:3000
npm run dev               # 更短的 SLA，方便观察超时预警
npm test                  # 状态机/冲突/幂等/预警的自动化测试
```

页面顶部选择身份（前台 / 保洁 / 值班经理），不同身份出现不同操作按钮；可开多个浏览器窗口模拟多人并发。
演示数据含 8 个包厢，其中 306/307/308 的状态停留时间已超过 demo SLA，启动即可看到预警。

## API

```
GET  /api/rooms                     看板快照（房间 + 预警）
GET  /api/rooms/:id/history?limit=50
POST /api/rooms/:id/transitions
     body: { action, expectedVersion, reason?, idempotencyKey? }
     header 可选: Idempotency-Key
GET  /api/events                    SSE（事件: transition / alerts / hello）
```

## 生产部署要点

- 多实例：把包厢锁和幂等表换成 Redis（`SET NX PX` 锁 + 幂等结果缓存），SSE 经 Redis pub/sub 广播；状态可迁到 PostgreSQL（`UPDATE ... WHERE version=?` 做乐观锁，事件表追加写入）。
- 鉴权：当前用 `X-User-Id / X-User-Name / X-Role` 头做演示，生产应换成会话/JWT 并在服务端解析角色，不信任前端传参。
- 数据：demo 用 JSONL 追加落盘，仅崩溃时丢未刷盘的少量事件；生产建议只把事件日志当审计，状态读数据库。
