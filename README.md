# 竞品情报多 Agent 市场研究系统

> 专注竞品数据分析的多 Agent 系统：自动监控竞品官网变化 → 深度调研 → 8 维对比矩阵 → 销售战卡 → 邮件告警。
>

```
用户 → POST /api/competitors/:id/analyze
  → monitor(抓取+哈希快筛+LLM分类) → research(搜索+洞察) → compare(8维矩阵)
  → battlecard(销售战卡) → quality(质检打分)
      └─ 分数 < 阈值 → 回 research 重搜（Reflexion 质量循环）
      └─ 达标/达上限 → 竞品回到 idle + high/critical 变化发邮件告警
每日调度 → daily_monitor → 遍历所有 enabled 竞品自动监控
```

## 快速开始（Demo 模式，无需任何 API Key）

```bash
npm install
cp .env.example .env
# .env 里设置 CI_DEMO_MODE=true（无 SERPAPI/SMTP key 也能全链跑通）
```

### 终端 A — 启动 API + 看板

```bash
CI_DEMO_MODE=true npm run api        # http://localhost:3013 （打开即看板）
```

### 终端 B — 启动 Worker（可多开）

```bash
CI_DEMO_MODE=true npm run worker -- --name w1
```

### 触发一次全流水线分析

```bash
# demo 模式启动时已自动 seed 一条「Demo 竞品 A」，直接分析它：
COMP_ID=$(curl -s http://localhost:3013/api/competitors \
  -H "Authorization: Bearer dev-123123" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).competitors[0].id))")

curl -X POST http://localhost:3013/api/competitors/$COMP_ID/analyze \
  -H "Authorization: Bearer dev-123123"
```

浏览器打开 http://localhost:3013/ 看任务链 **monitor → research → compare → battlecard → quality** 逐段跑通，看板出现变化表、8 维矩阵、战卡、告警记录。

> 没有 claude CLI 也想跑真分析？`AGENT_CLI=echo` 会用 demo 桩数据替代。配置真实 `SERPAPI_KEY` + `AGENT_CLI=claude` 后即为真实竞品情报系统。

## 核心能力

| 能力 | 说明 |
|---|---|
| **三级变化检测** | SHA-256 哈希快筛（省 LLM 调用）→ 结构化抽取（定价/招聘）→ LLM 语义分类为 `pricing/product/hiring/news/patent/blog/open_source` 并打 `low/medium/high/critical` 严重度 |
| **深度调研** | 财务/专利/技术博客/GitHub OSS/合作并购 5 类线索搜索 + LLM 产出洞察（带置信度） |
| **8 维对比矩阵** | 产品功能/定价价值/UX/市场份额/客户口碑/技术创新/生态集成/支持文档，我方 vs 竞品 0-10 双评分 |
| **销售战卡** | 优劣点/差异化/异议处理话术/电梯陈述，销售可直接使用 |
| **Reflexion 质量循环** | 战卡由质检 Agent 打分（1-10），低于阈值自动回 research 重搜，最多回炉 N 轮 |
| **邮件告警** | high/critical 变化自动发 SMTP 邮件（`alerts.change_id` 幂等去重） |
| **定时监控** | 默认每天 9 点（`CI_MONITOR_CRON`）遍历 enabled 竞品自动监控 |
| **共享记忆** | 每次分析沉淀可复用经验，新任务自动语义检索富化（复用 Agent Swarm 记忆层） |
| **崩溃恢复** | Worker 心跳超时任务自动重派，任意 Worker 崩溃不丢流水线 |

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OUR_PRODUCT_NAME/WEBSITE/POSITIONING/TARGET_MARKET` | 空 | **我方产品画像**（对比矩阵/战卡的基线） |
| `CI_MONITOR_CRON` | `0 9 * * *` | 每日监控 cron |
| `CI_QUALITY_THRESHOLD` | `7` | 战卡质检门槛（1-10） |
| `CI_MAX_REFLEXION_ROUNDS` | `2` | 质量回炉最大轮次 |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | 空 | 告警邮件 SMTP |
| `ALERT_EMAIL_TO` | 空 | 收件人（逗号分隔） |
| `SERPAPI_KEY/BASE_URL/SEARCH_ENGINE` | 空 | 搜索（无 key 用 demo 桩） |
| `CI_DEMO_MODE` | `false` | demo 模式（无 key 全链可跑） |
| `AGENT_CLI` | `claude` | LLM 命令行 Agent |
| `PORT/API_KEY/DB_PATH` | `3013/dev-123123/./agent-swarm.sqlite` | 基础配置 |

## API 一览

所有接口带 `Authorization: Bearer <API_KEY>`；Worker 产物接口额外带 `X-Agent-ID`。

### 竞品管理
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/competitors` | 注册竞品 `{name, website?, monitor_urls?[]}` |
| GET | `/api/competitors` | 竞品列表 |
| GET/PATCH/DELETE | `/api/competitors/:id` | 详情 / 更新 / 删除 |
| POST | `/api/competitors/:id/analyze` | 触发全流水线 |
| POST | `/api/competitors/:id/monitor` | 仅监控 |

### CI 产物查询（看板）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ci/competitors/:id/latest` | 聚合：竞品+矩阵+战卡+变化+洞察 |
| GET | `/api/ci/competitors/:id/changes\|insights\|matrices\|battlecards` | 各类产物 |
| GET | `/api/ci/alerts` | 告警记录 |
| GET | `/api/ci/profile` | 我方产品画像 |
| POST | `/api/ci/daily-monitor` | 遍历 enabled 竞品建监控任务 |

### Worker 产物上报（X-Agent-ID）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ci/pages/check` | 页面哈希快筛（三级检测第一级） |
| POST | `/api/ci/changes` | 上报变化（content_hash 去重） |
| POST | `/api/ci/insights` | 上报洞察 |
| POST | `/api/ci/matrices` | 上报对比矩阵 |
| POST | `/api/ci/battlecards` | 上报战卡 |
| POST | `/api/ci/quality` | 上报质检分 |

## 架构

```
┌──────────────────────────────────────────────────────┐
│  API Server（唯一持有 SQLite）                          │
│  任务池/心跳清扫/调度/看板 + CI orchestrator（stage 接力）│
└───────┬──────────────────────────────────────────────┘
        │ HTTP (X-Agent-ID)
   ┌────┴─────┐
   ▼ Worker×N │
   ① 领到 CI 任务（tags: ['ci', stage, 竞品ID, 'mode:round']）
   ② 跑确定性工具：抓取/哈希/抽取/搜索
   ③ 构建 stage prompt → claude CLI 执行
   ④ 上报产物 → 上报 completed
   ⑤ orchestrator 收到完成事件 → 建下个 stage 任务（含 Reflexion 回炉）
```

**架构基石**（沿用 Agent Swarm）：API Server 独占数据库，Worker 一律走 HTTP（`src/ci/execute.ts` 只 import `worker/client.ts`），保证多进程无锁竞争、数据一致。

**CI 流水线 = 任务池上的 stage 接力**：每个 stage 是一个独立 Worker 任务，天然复用原子认领、心跳崩溃恢复、共享记忆、调度、看板。单 stage 崩溃自动重派，不同竞品可并行分析。

## 目录结构（CI 相关）

```
src/
├── ci/                    # 竞品情报领域层
│   ├── orchestrator.ts    # 流水线编排（stage 接力 + Reflexion 循环）
│   ├── execute.ts         # Worker 侧 stage 执行器（工具→prompt→agent→产物）
│   ├── prompts.ts         # 5 类 stage 提示词（中文，输出 JSON）
│   ├── parse.ts           # Agent 输出 JSON 宽容解析
│   ├── alert.ts           # SMTP 邮件告警（幂等去重）
│   ├── demo.ts            # Demo 模式桩数据（无 key 全链可跑）
│   └── tools/             # 确定性工具
│       ├── http.ts        # 页面抓取（重试/UA/超时）
│       ├── hash.ts        # SHA-256 内容哈希
│       ├── extract.ts     # 文本/定价/招聘启发式抽取
│       └── search.ts      # SerpAPI 兼容搜索
├── db/queries/
│   ├── competitors.ts     # 竞品 CRUD
│   └── ci.ts              # 变化/洞察/矩阵/战卡/告警/页面哈希
├── api/handlers/
│   ├── competitors.ts     # 竞品 CRUD + 分析/监控触发
│   └── ci.ts              # CI 产物查询 + Worker 上报
└── ui/index.html          # 看板（竞品/变化/矩阵/战卡/告警）
```

## 测试

```bash
npm test   # 41 个用例：任务状态机 + CI 查询/工具/解析/orchestrator
```

## 里程碑对照

| 阶段 | 内容 | 演示 |
|---|---|---|
| M1 | 竞品注册 + 数据层 | 注册竞品 → 看板列表 |
| M2 | 流水线骨架 + demo | 点分析 → 5 stage 全链跑通（无 key） |
| M3 | 确定性工具 | 真实抓取检测变化 |
| M4 | SMTP 告警 + Reflexion | 收邮件 + 战卡自动回炉 |
| M5 | 看板 + 定时 + README | 完整产品演示 |
