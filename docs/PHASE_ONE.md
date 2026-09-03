# 阶段一运行说明

正式入口为 Analysis Brief → Run → Evidence → Claim → Report。

## 启动

1. 执行 `npm run migrate:mysql`。
2. 配置不同的 `API_KEY` 与 `SERVICE_API_KEY`。
3. 生产设置 `ALLOW_LEGACY_API_KEY=false`，并配置至少 12 位的 `ADMIN_PASSWORD`。
4. 启动 API 与 Worker。Worker 只使用服务身份，不可审核证据或发布报告。

## 可靠性

- 创建运行与 `run.queued` Outbox 在同一事务提交。
- Outbox 至少一次投递；`(run_id, stage, round)` 唯一键消除重复阶段。
- Worker/API 重启后，未处理 Outbox 与未完成任务继续执行。
- 失败运行调用 `POST /api/runs/:id/retry` 只重建失败阶段。

## 审核门禁

- Evidence 与 Claim 默认为 `pending`。
- 未授权使用未核验证据时，research 后进入 `waiting_review`。
- Evidence/Claim 均核验后，再调用 retry 从 compare 继续。
- 驳回或过期 Evidence 会使依赖 Claim、产物和已发布报告失效。

接口契约见 [openapi.phase-one.yaml](./openapi.phase-one.yaml)。
