# CI Agent 

阶段一采用“前后端分离 + 后端模块化单体”。API、编排器和 Worker 独立进程部署，共享同一代码仓库与 MySQL；内部队列使用任务表和事务 Outbox，资产使用可持久化文件卷，暂不引入微服务复杂度。后续可分别替换为专业消息队列和对象存储。

## 目录

```text
apps/
├── web/                 React + TypeScript 控制台
├── api/                 HTTP API / BFF、鉴权、数据访问
├── orchestrator/        流水线、调度、Outbox、故障恢复
└── worker/              无状态 Agent Worker
packages/
├── contracts/           OpenAPI、共享类型和标签 Schema
├── domain/              领域状态机
├── agent-runtime/       Agent、工具和模型适配
├── platform/            配置与日志
└── ui-components/       通用 React 组件
infrastructure/
├── migrations/          MySQL DDL 与迁移入口
├── docker/              五服务本地部署
└── monitoring/          健康检查与告警基线
```

## 本地启动

要求：Node.js 22、MySQL 8。

```bash
npm install
cp .env.example .env
npm run migrate:mysql
```

分别启动四个进程：

```bash
npm run api
npm run orchestrator
npm run worker -- --name worker-1
npm run web
```

访问 `http://localhost:5173`。生产前必须修改 API Key、Service Key 和管理员密码，并将 `ALLOW_LEGACY_API_KEY=false`。

## Docker

```bash
docker compose -f infrastructure/docker/docker-compose.yml up --build
```

访问 `http://localhost:8080`。可使用 `--scale worker=3` 横向扩展 Worker。

## 依赖方向

```text
Web → API → MySQL / Outbox
              ↑
     Orchestrator → Worker（HTTP 领任务、上报结果）

apps → packages
API 不直接调用 Orchestrator；Worker 不直接访问数据库。
```

阶段一已包含：分析 Brief、预检与运行快照、阶段幂等、证据与 Claim 审核门禁、报告状态机、事务 Outbox、会话鉴权、SSRF 防护、审计日志、React 操作台。

API 契约见 [packages/contracts/openapi.yaml](packages/contracts/openapi.yaml)，实现说明见 [docs/PHASE_ONE.md](docs/PHASE_ONE.md)。

## 验证

```bash
npm run typecheck
npm run build:web
npm test
```

FastAPI 或 LangChain 暂未加入：现有 TypeScript HTTP 层已满足阶段一，避免双后端栈；模型调用集中在 `packages/agent-runtime`，后续可在该适配层接入 LangChain，不影响 API 契约。
