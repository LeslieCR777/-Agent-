# Agent Swarm

一套让多个 **AI Agent（Claude Code 等命令行 Agent）** 像团队一样协作执行任务的编排系统：

- **Lead** 拆解复杂任务 → 多个 **Worker** 并行执行
- **共享记忆**：任务完成后沉淀可复用经验，新任务自动语义检索富化 prompt
- **心跳 + 崩溃恢复**：任何 Worker 崩溃任务不丢
- **cron 定时调度** + **WebSocket 实时看板**

## 快速开始

```bash
npm install
cp .env.example .env        # 默认 API Key: dev-123123
```

### 终端 A — 启动 API + 看板

```bash
npm run api                 # http://localhost:3013 （打开即看板）
```

### 终端 B / C — 启动 Worker（可多开，模拟多 Worker）

```bash
AGENT_CLI=claude npm run worker -- --name w1
AGENT_CLI=claude npm run worker -- --name w2
```

> 没有 claude CLI 或想快速验证链路时，用 `AGENT_CLI=echo` 模拟（echo 会把 prompt 当结果回传）。

### 创建任务

```bash
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer dev-123123" -H "Content-Type: application/json" \
  -d '{"title":"demo","prompt":"回答 1+1 等于几"}'
```

浏览器打开 http://localhost:3013/ 看任务实时流转。

## 核心功能演示

| 功能 | 命令 | 看什么 |
|---|---|---|
| 任务闭环 | 上面创建任务 | Worker 认领 → claude 执行 → 结果入库 |
| 崩溃恢复 | 执行长任务时 `kill` 掉 worker | ~30s 后任务被另一 Worker 接管 |
| 共享记忆 | 建两个相似任务 | 第二个任务 prompt 自动带上第一条的经验 |
| Lead 拆解 | `npm run lead -- --taskId <父任务ID>` | 拆成子任务并行执行后汇总 |
| 定时调度 | `POST /api/schedules` 建 cron | 到点自动创建任务 |
| 实时看板 | 浏览器开首页 | WebSocket 推送任务流转 |
| 文件资产 | 见下节 | 大文件存资产库，任务按需引用，prompt 保持精简 |

## 文件资产库（给 Worker 喂数据）

避免在 prompt 里粘贴大段数据（费 token 且易失真）。把数据文件上传到资产库，任务引用资产，Worker 执行时自动把文件拷进任务专属目录，claude 按需读取。

```bash
# 1. 上传数据文件 → 得到一个资产 id
AID=$(curl -X POST "http://localhost:3013/api/assets?filename=sales.csv" \
  -H "Authorization: Bearer dev-123123" -H "Content-Type: text/csv" \
  --data-binary @sales.csv | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).asset.id))")

# 2. 创建任务时用 attachments 引用资产
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer dev-123123" -H "Content-Type: application/json" \
  -d "{\"title\":\"分析\",\"prompt\":\"读取 ./sales.csv 分析趋势\",\"attachments\":[\"$AID\"]}"

# 3. Worker 把资产拷入 .agent-workspace/tasks/<taskId>/，claude 直接读文件
```

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/assets?filename=` | 上传（原始 body） |
| GET | `/api/assets` | 资产列表 |
| GET | `/api/assets/:id` | 下载文件本体 |
| DELETE | `/api/assets/:id` | 删除 |

每个任务有**独立工作目录** `.agent-workspace/tasks/<taskId>/`，多 Worker 并行互不干扰。

## API 一览

所有接口带 `Authorization: Bearer <API_KEY>`；Worker 额外带 `X-Agent-ID`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tasks` | 创建任务 `{title, prompt, priority?, source?, tags?}` |
| GET | `/api/tasks` | 任务列表 `?status=&priority=&page=&size=` |
| GET | `/api/tasks/:id` | 任务详情（流转历史 + session） |
| POST | `/api/tasks/next` | **Worker 原子领取下一个任务** |
| POST | `/api/tasks/:id/claim` | 手动认领指定任务 |
| PATCH | `/api/tasks/:id/status` | 上报状态/日志/结果 |
| POST | `/api/agents/register` | Worker 注册 |
| POST | `/api/agents/:id/heartbeat` | 心跳上报（5s） |
| GET | `/api/agents` | Worker 状态列表（idle/busy/offline） |
| POST | `/api/memories` | 写入记忆（内部沉淀） |
| GET | `/api/memories/search?q=` | 语义检索 Top-K |
| DELETE | `/api/memories/:id` | 删除记忆 |
| GET | `/api/events?since=` | 事件流（增量拉取） |
| POST | `/api/assets` | 上传文件资产（原始 body，`?filename=` 指定名） |
| GET | `/api/assets` | 资产列表 |
| GET | `/api/assets/:id` | 下载资产文件 |
| DELETE | `/api/assets/:id` | 删除资产 |
| POST | `/api/schedules` | 创建 cron 定时任务 |
| GET | `/api/stats` | 仪表盘统计 |
| GET | `/api/health` | 健康检查 |

## 架构

```
用户/系统 ── HTTP/Slack/GitHub/cron ──▶ API Server（唯一持有 SQLite）
                                          │ 任务池/心跳清扫/调度/看板
              ┌───────────────────────────┤
              ▼  HTTP (X-Agent-ID)        ▼
         Worker×N（Docker 或本地多开）   Lead（拆解/汇总）
              │  调用 claude CLI 子进程
              ▼  执行任务，回传日志/结果
```

**架构基石**：API Server 是数据库唯一持有者。Worker/Lead 一律通过 HTTP 访问数据（`src/worker/client.ts`），禁止直连数据库——保证多进程下无锁竞争、数据一致。

## 任务状态机

```
unassigned ─claim─▶ claimed ─start─▶ in_progress ──▶ completed / failed / superseded
     ▲                │   \                              │
     └── 心跳超时重派 ─┘    └── Worker 崩溃 → stale ─────┘
```

- 认领用原子 `UPDATE ... WHERE status='unassigned'`，影响行数判胜，杜绝两个 Worker 抢同一任务
- 认领超 `MAX_ASSIGN_COUNT`（默认 3）仍失败 → 标 `failed`，防死循环重派
- 状态全部落 SQLite，API 重启即恢复

## 共享记忆

1. **沉淀**：任务完成后，Agent 从执行输出中提炼"可复用经验" → Embedding 向量化 → 入库（异步，失败不影响主流程）
2. **检索**：新任务创建时，prompt 向量化 → 余弦相似度 Top-K → 以「相关经验」段落拼进 prompt
3. Embedding 默认走 **OpenAI**（`.env` 填 `EMBEDDING_API_KEY`）；留空自动降级为离线哈希向量，系统不依赖网络也能跑

## 测试

```bash
npm test        # 14 个用例：状态机/认领原子性/心跳恢复/向量检索
```

## 目录结构

```
src/
├── server.ts          # API 入口：路由 + 清扫 + 调度 + WS + 看板
├── db/                # 数据库层（schema + 事务 + 查询封装）
├── api/               # HTTP 路由 + handler + 中间件
├── worker/            # Worker 主循环（领任务→跑 claude→上报）
├── lead/              # Lead Agent（拆解→派发→汇总）
├── memory/            # 共享记忆（embed/search/distill/enrich）
├── scheduler/         # cron 调度器
├── heartbeat/         # 服务端心跳清扫
├── ws/                # WebSocket 事件推送
├── shared/            # 类型/常量/配置/日志
└── ui/                # 看板单页
```

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3013 | API 端口 |
| `API_KEY` | dev-123123 | API Key |
| `HEARTBEAT_INTERVAL_MS` | 5000 | Worker 心跳间隔 |
| `HEARTBEAT_TIMEOUT_MS` | 30000 | 超时判定阈值 |
| `MAX_ASSIGN_COUNT` | 3 | 单任务最大认领次数 |
| `AGENT_CLI` | claude | 命令行 Agent |
| `EMBEDDING_API_KEY` | 空 | OpenAI Key（空则离线降级） |
