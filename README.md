<div align="center">

# 🔭 竞品分析 Agent

### 可持续运行、证据可追溯的多 Agent 竞品情报系统

**自动监测 · 深度研究 · 八维对比 · 销售战卡 · 多视角质检 · 行动闭环**

[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=black)](https://react.dev/)
[![MySQL](https://img.shields.io/badge/MySQL-8.4-4479A1.svg?logo=mysql&logoColor=white)](https://www.mysql.com/)

[快速开始](#-快速开始) · [核心能力](#-核心能力) · [系统架构](#-系统架构) · [API](#-api-与数据契约) · [项目状态](#-honest-status) · [路线图](#-产品路线图)

</div>

---

## 📖 项目简介

竞品分析 Agent 是一套面向分析师、产品、市场和销售团队的持续竞品情报系统。它把官网变化、公开搜索、产品资料和人工审核组织成一条可恢复的生产流水线，最终形成结构化变化记录、研究洞察、八维对比矩阵、销售战卡和可审计报告。

它解决的不是“让模型写一份竞品报告”，而是三个更实际的问题：

| 业务断点 | 系统能力 |
|---|---|
| **信号断点**：页面更新多、噪声大、容易漏掉真正变化 | 哈希快筛 → 结构化抽取 → 语义判断的三级检测 |
| **判断断点**：事实、观点和结论混在一起 | Evidence → Claim → Insight → Report 可追溯证据链 |
| **行动断点**：分析停留在文档，无法支持一线动作 | 八维矩阵、销售战卡、告警和持续行动路线图 |

```text
变化信号 → Monitor → Research → Compare → Battlecard → Quality Gate
                 │                                      │
                 └─ 无有效变化：记录快照后提前结束       └─ 质量不足：携带反馈回炉
```

---

## ✨ 核心能力

### 1. 五阶段 Agent 流水线

| 阶段 | 职责 | 结构化产物 |
|---|---|---|
| **Monitor** | 抓取页面、哈希快筛、识别有效变化与严重度 | Change Event |
| **Research** | 聚合搜索与页面证据，形成可核验洞察 | Evidence / Claim / Insight |
| **Compare** | 按统一维度比较我方产品与竞品 | Comparison Matrix |
| **Battlecard** | 生成定位、优势、突破口和异议处理话术 | Sales Battlecard |
| **Quality** | 多视角检查准确性、完整性和销售可用性 | Quality Review |

Quality 阶段可由多个独立评审视角聚合打分。低于门槛时不会直接交付，而是带着反馈进入下一轮研究和生成，循环次数由配置控制。

### 2. 证据先于结论

- 每次分析从 `Analysis Brief` 创建独立 `Run`，保存运行时输入快照。
- Evidence 与 Claim 具有 `pending / verified / rejected / expired` 等审核状态。
- 未满足审核策略的运行进入 `waiting_review`，不会静默生成正式结论。
- 报告发布前检查引用门禁；上游证据被驳回或过期后，下游 Claim、产物和报告会失效。
- 历史报告保留运行时快照，不因产品资料更新而被静默改写。

### 3. 可恢复的任务编排

- API、Orchestrator 和 Worker 独立进程部署。
- 创建运行和事务 Outbox 同时提交，避免业务状态已写入但任务未投递。
- 每个阶段使用唯一键 `(run_id, stage, round)`，重复消息不会重复生成正式阶段。
- Worker 通过 HTTP 原子认领任务、上报心跳和结果，不直接访问数据库。
- Worker 失联后任务可回收重派；失败运行支持只重试失败阶段。

### 4. 专业竞品分析产物

- 产品功能、定价与价值、用户体验、市场份额、用户评价、创新速度、生态系统、支持与文档八维矩阵。
- 我方产品画像与竞品数据使用同一分析上下文。
- 销售战卡包含双方优劣势、关键差异、异议处理和电梯陈述。
- High/Critical 变化支持 SMTP 邮件告警，并通过 `change_id` 幂等去重。
- 每日定时任务遍历启用中的竞品，自动发起监测。

### 5. 持续研究项目与产品时间线

阶段二批次 0–1 已加入：

- Research Project、项目成员、研究目标、市场、渠道和来源策略。
- Company → Brand → Product Series → SKU 完整产品层级。
- CSV 映射预览、重复检测和人工确认入库。
- SKU 价格快照、参数快照及市场/渠道/币种上下文。
- 项目仪表盘与价格、参数时间线。

### 6. React 操作台

前端使用 React + TypeScript + Vite，覆盖运行创建与进度、证据和 Claim 审核、分析结果、项目空间、产品目录、资产和系统状态。界面默认展示业务结论，技术日志和运行细节按需下钻。

---

## 🏗️ 系统架构

```text
┌─────────────────────────────────────────────────────────────────┐
│                  React + TypeScript Web                          │
│  项目 · 运行 · 证据审核 · 对比矩阵 · 战卡 · 报告 · 系统状态       │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP / WebSocket
┌──────────────────────────────▼──────────────────────────────────┐
│                         API / BFF                                │
│  鉴权 · Schema 校验 · 数据访问 · 审计 · 事务 Outbox · 文件安全    │
└──────────────┬───────────────────────────────────┬──────────────┘
               │ MySQL                            │ Outbox Event
┌──────────────▼──────────────┐      ┌─────────────▼──────────────┐
│ MySQL 8                     │      │ Orchestrator               │
│ 业务事实 · 运行状态 · 审计   │◀─────│ 状态机 · 调度 · 恢复 · 告警 │
└─────────────────────────────┘      └─────────────┬──────────────┘
                                                   │ HTTP 认领/上报
                                    ┌──────────────▼─────────────┐
                                    │ Stateless Worker × N       │
                                    │ 抓取 · 搜索 · 模型 · 质检   │
                                    └────────────────────────────┘
```

### 关键边界

- **API 不直接执行 Agent 流水线**：在线请求和长任务分离。
- **Worker 不直接访问数据库**：所有业务写入经过 API 和统一校验。
- **apps 依赖 packages**：领域状态机、契约、运行时和平台配置可复用。
- **阶段一保持模块化单体**：避免过早拆微服务；队列和资产存储可按规模替换。

### Monorepo 结构

```text
apps/
├── web/                 React + TypeScript 控制台
├── api/                 HTTP API / BFF、鉴权、数据访问
├── orchestrator/        流水线、调度、Outbox、故障恢复
└── worker/              无状态 Agent Worker
packages/
├── contracts/           OpenAPI、共享类型和标签 Schema
├── domain/              Run、Stage、Evidence、Report 状态机
├── agent-runtime/       Agent、工具、模型和评测运行时
├── platform/            配置与结构化日志
└── ui-components/       通用 React 组件
infrastructure/
├── migrations/          MySQL DDL 与版本化迁移
├── docker/              五服务本地部署
└── monitoring/          健康检查与告警基线
```

---

## 🚀 快速开始

### Demo 模式：无需模型或搜索 Key

要求：Node.js 22、MySQL 8。

```bash
git clone https://github.com/LeslieCR777/-Agent-.git
cd ./-Agent-
npm install
cp .env.example .env
```

在 `.env` 中至少确认：

```dotenv
CI_DEMO_MODE=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=agent_swarm
```

执行迁移：

```bash
npm run migrate:mysql
```

分别启动四个进程：

```bash
npm run api
npm run orchestrator
npm run worker -- --name worker-1
npm run web
```

访问 <http://localhost:5173>。本地旧式 API Key 默认值仅用于开发；生产环境必须设置独立强密钥和管理员账号。

### Docker 一键启动

```bash
docker compose -f infrastructure/docker/docker-compose.yml up --build
```

访问 <http://localhost:8080>。横向扩展 Worker：

```bash
docker compose -f infrastructure/docker/docker-compose.yml up --build --scale worker=3
```

### 接入真实模型和搜索

关闭 Demo 模式后配置：

```dotenv
CI_DEMO_MODE=false
ANTHROPIC_API_KEY=your-key
AGENT_MODEL=your-model
SERPAPI_KEY=your-serpapi-key
```

可选配置 DeepSeek 兼容接口作为 Quality 多评审模型，以及 SMTP 作为重大变化通知渠道。详细变量说明见 [.env.example](.env.example)。

---

## 📡 API 与数据契约

完整 OpenAPI 契约见 [packages/contracts/openapi.yaml](packages/contracts/openapi.yaml)。所有写接口通过服务端 Schema、身份和领域状态机校验，统一错误响应包含 `code`、`message`、`details`、`trace_id`。

### 分析运行

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/analysis-briefs` | 创建分析任务单 |
| `POST` | `/api/runs` | 从 Brief 启动可复现运行 |
| `GET` | `/api/runs` | 分页查询运行 |
| `GET` | `/api/runs/:id` | 运行、阶段和快照详情 |
| `POST` | `/api/runs/:id/cancel` | 取消运行 |
| `POST` | `/api/runs/:id/retry` | 重试失败或审核后可继续的阶段 |

### 证据、Claim 与报告

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/evidence` | 分页查询 Evidence |
| `PATCH` | `/api/evidence/:id/review` | 核验或驳回 Evidence |
| `GET` | `/api/claims` | 分页查询 Claim |
| `PATCH` | `/api/claims/:id/review` | 审核 Claim |
| `POST` | `/api/reports` | 基于运行创建版本化报告 |
| `POST` | `/api/reports/:id/:action` | 提交、审批、发布等状态流转 |
| `GET` | `/api/reports/:id/export` | 导出 Markdown 或 PDF |

### 持续研究项目

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST/GET` | `/api/projects` | 创建和查询 Research Project |
| `GET` | `/api/projects/:id/dashboard` | 项目覆盖、新鲜度和待办摘要 |
| `POST` | `/api/projects/:id/members` | 管理项目成员角色 |
| `GET` | `/api/catalog` | 查询公司、品牌、系列和 SKU |
| `POST` | `/api/catalog/imports/preview` | CSV 映射预览与重复检测 |
| `POST` | `/api/catalog/imports/:id/confirm` | 人工确认后入库 |
| `POST` | `/api/skus/:id/price-snapshots` | 保存市场/渠道价格快照 |
| `POST` | `/api/skus/:id/product-snapshots` | 保存参数事实和来源 |
| `GET` | `/api/skus/:id/timeline` | 查询价格与参数时间线 |

---

## 🔐 安全与治理

- 用户会话身份与 Worker 服务身份分离，服务令牌按 Scope 限制。
- 生产设置 `ALLOW_LEGACY_API_KEY=false`，关闭兼容开发 Key。
- 抓取仅允许 HTTP/HTTPS，拒绝回环、私网、链路本地和云元数据地址；重定向逐跳复核。
- 发布、驳回、删除和配置修改写入审计日志。
- 上传资产经过大小、类型和安全校验，持久化卷与在线服务隔离。
- Worker 无权审核证据或发布报告，也不能绕过 API 直接写数据库。

## 🧪 验证

```bash
npm run typecheck
npm run build:web
npm test
```

评测运行：

```bash
npm run eval:gen
npm run eval
npm run eval:report
```

测试覆盖领域状态机、幂等与恢复、证据和 Claim 门禁、API、抓取安全、竞品分析工具、项目目录及评测 Harness。

---

## ✅ Honest Status

这里明确区分已交付代码和后续产品规划，避免把目标架构写成现有能力。

| 能力 | 状态 | 说明 |
|---|---|---|
| React + TypeScript 操作台 | ✅ Built | 运行、证据、Claim、结果、项目和目录页面 |
| 五阶段 CI Pipeline | ✅ Built | Monitor → Research → Compare → Battlecard → Quality |
| 多视角 Quality Gate | ✅ Built | 支持多个 Judge 与低质量回炉 |
| Analysis Brief / Run / Stage | ✅ Built | 快照、显式状态、阶段幂等、取消和重试 |
| Evidence / Claim 审核门禁 | ✅ Built | 驳回和过期可使依赖产物失效 |
| 报告状态机与基础导出 | ✅ Built | 版本、审批、发布、Markdown/PDF |
| 事务 Outbox 与恢复 | ✅ Built | 至少一次投递、心跳、超时重派 |
| 登录、服务令牌和审计 | ✅ Built | 用户与 Worker 身份分离 |
| SSRF 防护 | ✅ Built | URL、重定向、内容类型和大小约束 |
| Research Project | ✅ Built | 项目成员、目标、市场、渠道、来源策略 |
| 产品目录和 SKU 时间线 | ✅ Built | 层级、CSV 导入、价格和参数快照 |
| Demo 全链路 | ✅ Built | 无模型/搜索 Key 可运行确定性桩数据 |
| 报告评论与任意版本 Diff | 📋 Planned | 阶段二批次 3 |
| 组合告警与 Action Item | 📋 Planned | 阶段二批次 4 |
| 文件解析、分层记忆治理 | 📋 Planned | 阶段二批次 5 |
| 统一 LLM Gateway / OTel Trace | 📋 Planned | 阶段二批次 5 |
| 多租户、SSO、知识图谱 | 📋 Planned | 阶段三 |

---

## 🗺️ 产品路线图

### 已完成：阶段一

目标是让分析运行达到“可靠、可恢复、可追溯、可审核”：

- 显式 Run/Stage 状态与事务 Outbox。
- Evidence → Claim → Artifact 引用关系。
- 报告版本、状态机、发布门禁和运行快照。
- 会话鉴权、服务身份、SSRF 防护与审计。
- React 组件化操作台与 Docker 部署。

详见 [阶段一运行说明](docs/PHASE_ONE.md)。

### 已完成：阶段二批次 0–1

- 持续 Research Project 和项目成员。
- Company → Brand → Series → SKU 完整目录。
- CSV 预览/确认、重复检测。
- 价格和参数时间线，保留市场、渠道与原币种。

详见 [阶段二批次 0–1](docs/PHASE_TWO_BATCH_01.md)。

### 计划：批次 3 · 报告协作

- 报告修订记录、块级引用完整性检查。
- 评论、回复、解决评论和模板版本。
- 任意两个报告版本的正文、分数和证据差异比较。
- Markdown、JSON、CSV 导出；Word、PPT、PDF 使用独立适配层。
- 删除引用后，依赖段落自动变为未核验。

### 计划：批次 4 · 告警、行动和角色界面

- 组合告警规则、时间窗口去重、确认、忽略、静默和升级。
- Insight/Alert 转 Action Item，跟踪负责人、截止时间、优先级和结果。
- 管理者、分析师和销售三类工作台。
- 战卡复制、证据展开和使用反馈统计。

### 计划：批次 5 · 资产、记忆和模型网关

- PDF、Word、Excel、CSV 和图片解析适配层。
- 文档切片、页码、表格、Sheet 和单元格定位。
- 分层记忆、版本、有效期、可信度和失效传播。
- 统一 LLM Gateway：超时、重试、熔断、降级、成本和提示词版本。
- `run_id`、`stage_id`、`trace_id` 全链路关联。

### 远期：阶段三企业能力

- 多租户、SSO/SCIM、细粒度权限和不可篡改审计。
- 高可用队列、对象存储、搜索与向量检索。
- 竞争情报知识图谱、组合洞察和受治理的自主 Agent。

---

## 📚 文档导航

| 文档 | 内容 |
|---|---|
| [OpenAPI 契约](packages/contracts/openapi.yaml) | API Schema 与统一错误结构 |
| [阶段一运行说明](docs/PHASE_ONE.md) | 可靠性、恢复和审核门禁 |
| [阶段二批次 0–1](docs/PHASE_TWO_BATCH_01.md) | 项目、目录、CSV 和时间线 |
| [.env.example](.env.example) | 全部运行配置与安全提示 |

## 🤝 Contributing

欢迎通过 Issue 或 Pull Request 完善数据源、Agent 工具、Evidence/Citation 模型、评测用例和角色化体验。

提交前请运行类型检查、前端构建和测试，并说明影响的领域状态、API 契约与数据迁移。

<div align="center">

**让竞品信息从“零散资料”变成可核验、可比较、可行动的持续情报。**

如果这个项目对你有帮助，欢迎 Star ⭐

</div>
