# 交接文档（HANDOFF）

> 更新于：2026-08-05
> 状态：**MySQL 迁移进行中（WIP）**，尚未完成，系统当前处于"迁移半成品"状态 —— **不要直接运行**，需完成剩余步骤后恢复可用。

---

## 一、项目定位

把 **agent-swarm**（通用 Lead-Worker 多 Agent 任务编排系统）改造成**竞品情报多 Agent 市场研究系统**：
- 自动监控竞品官网变化 → 深度调研 → 8 维对比矩阵 → 销售战卡 → 邮件告警
- 参考 [competitive-intelligence-multi-agent](https://github.com/bcefghj/competitive-intelligence-multi-agent)

已完成的**历史里程碑**（此前已实现、SQLite 版全绿）：
- CI 领域层：5 类 stage（monitor/research/compare/battlecard/quality）+ orchestrator 接力 + Reflexion 质量循环
- 确定性工具：抓取/哈希/抽取/搜索 + Demo 模式（无 key 全链可跑）
- SMTP 邮件告警（幂等去重）
- 前端看板：深色科技风 5 Tab（总览/竞品情报/任务中心/资产库/系统）
- 41 个测试全绿（SQLite 版）

---

## 二、当前进行中的工作：四项升级（WIP）

用户本轮的四个诉求，**前两项在实施中，后两项未开始**：

| # | 升级 | 状态 | 说明 |
|---|---|---|---|
| 1 | **MySQL 存储**（全面迁移） | 🔶 **进行中** | 连接层已重写、11 个 query 文件已异步化、schema.mysql.sql 已建。**tsc 未绿**（迁移未完成） |
| 2 | **更强模型 + 多 agent 评审** | ⏳ 未开始 | 计划：分析主阶段 claude-opus-5，评审用 DeepSeek API，3 judge 投票 |
| 3 | **竞品情报更详细** | ⏳ 未开始 | 计划：增强各 stage prompt 细节（评分锚点/思考链/字段） |
| 4 | **使用说明页** | ⏳ 未开始 | 计划：看板新增「使用说明」Tab |

---

## 三、MySQL 迁移已完成的改动

### 已重写/新建的文件

| 文件 | 改动 |
|---|---|
| `src/db/index.ts` | **重写**：`node:sqlite` 同步 → `mysql2/promise` 连接池 + AsyncLocalStorage 嵌套事务（`withTransaction` 变 async，`conn()` 事务内取连接） |
| `src/db/schema.mysql.sql` | **新建**：MySQL 版建表 DDL（VARCHAR 主键、LONGBLOB、`INSERT IGNORE`、去 partial index） |
| `scripts/migrate.mysql.ts` | **新建**：迁移脚本（自动建库建表，幂等） |
| `src/db/queries/*.ts`（11 个） | **全异步化**：`getDb().prepare().all()` → `await getPool().execute()`；`res.changes` → `result.affectedRows`；`INSERT OR IGNORE` → `INSERT IGNORE`；`output \|\| ?` → `CONCAT()`；JSON 保持 TEXT |
| `src/db/queries/tasks.ts` | **claim 原子性重写**：`SELECT ... FOR UPDATE SKIP LOCKED` + 条件 UPDATE（替代会死循环的快照读重试） |
| `src/api/handlers/*.ts`（9 个） | 所有 handler 改 async + await |
| `src/heartbeat/sweeper.ts` | `recoverAgent` 全 await |
| `src/scheduler/index.ts` | `fire/runSchedulerTick` 全 await |
| `src/ci/orchestrator.ts` | `kickoffPipeline/onCiTaskCompleted/onCiTaskFailed/createStage` 全 async |
| `src/ci/alert.ts` | `deliver/maybeSendAlerts` 内部 DB 调用 await |
| `src/memory/{search,distill}.ts` | `allMemoriesWithVector`/`createMemory` await |
| `src/shared/config.ts` | 新增 `mysql` / `deepseek` / `agentModel` / `ciJudgeCount` 配置 |
| `src/shared/constants.ts` | 新增 `ENV.MYSQL_*`、`ENV.DEEPSEEK_*`、`ENV.AGENT_MODEL`、`ENV.CI_JUDGE_COUNT` |
| `src/shared/logger.ts` | secrets 加 `mysql.password` / `deepseek.apiKey` |
| `.env.example` | 新增 MySQL / DeepSeek / AGENT_MODEL / CI_JUDGE_COUNT 段 |
| `package.json` | 新增 `mysql2` 依赖 |

### 已装但未用的 skill（用户插入请求）
- `vibehub` skill 已安装到 `C:\Users\Lesile\.claude\skills\vibehub\`（术语解析，重启 Claude Code 生效）

---

## 四、迁移剩余工作（TODO）

### 1. 🔴 修复 tsc 错误（当前最大的坑）
迁移后 `npx tsc --noEmit` 报约 **130+ 错误**：
- `src/db/queries/*.ts` 约 32 个：`execute()` 返回 `QueryResult`（联合类型），解构 `const [rows] = await ...execute()` 时 rows 是 `QueryResult` 而非可索引数组，且不能直接赋给业务类型数组。
  - **下一步方案**：在 `src/db/index.ts` 导出一个 `query<T>(sql, params): Promise<T[]>` 辅助函数，内部 `const [rows] = await pool.execute(sql, params); return rows as T[];`，所有查询层改用它 —— 比逐个修 `QueryResult` 联合类型干净。
  - 或者：给每个 `execute()` 返回处加 `as unknown as Xxx[]` 断言。
- 测试文件约 114 个：`tests/helpers.ts` 还需改成连 MySQL 测试库（见下）。

### 2. 🔴 测试基建改 MySQL
`tests/helpers.ts` 目前连临时 SQLite。需改为：
- 连 MySQL 测试库（如 `agent_swarm_test`），`beforeEach` 清表或重建
- 所有测试断言加 `await`（因为 query 全异步）
- 41 个用例（`tasks/heartbeat/memory/assets/competitors/ci-query/ci-tools/ci-parse/ci-orchestrator`）全部适配

### 3. 🟡 MySQL 实例配置
用户已确认**有 MySQL 实例**。需在 `.env` 填：
```
MYSQL_HOST=…
MYSQL_PORT=3306
MYSQL_USER=…
MYSQL_PASSWORD=…
MYSQL_DATABASE=agent_swarm
```
然后跑 `node --import tsx scripts/migrate.mysql.ts` 建表。

### 4. ⏳ 强模型 + DeepSeek 评审 + 3 judge 投票
计划（未实施）：
- `src/worker/runner.ts` `spawnAgent` 加 `--model <config.agentModel>`（默认 claude-opus-5）
- 新建 `src/ci/judge.ts`：DeepSeek OpenAI 兼容 API 调用
- `src/ci/execute.ts` quality stage 并行 3 个评审 prompt（准确性/完整性/可执行性），`Promise.all` 聚合均值 + 反馈拼接
- `src/ci/prompts.ts` 各 stage 增强（评分锚点、思考链、字段扩展）

### 5. ⏳ 使用说明页
`src/ui/index.html` 新增「使用说明」Tab。

---

## 五、已知问题 / 风险

1. **系统当前不可运行**：tsc 未绿，MySQL 迁移半成品。**务必先完成迁移再跑**。
2. **claim 原子性**：`SELECT ... FOR UPDATE SKIP LOCKED` 需要 MySQL 8.0+。若用户 MySQL 版本 < 8.0，需降级方案（READ COMMITTED + 原重试循环）。
3. **`conn()` 语义**：`conn()` 只能在 `withTransaction` 内调用（返回事务连接）；事务外用 `getPool().execute()`。查询层已按此约定写，但若有遗漏调用 `conn()` 在事务外会抛错。
4. **MySQL `COUNT(*)` 返回字符串**：`Number()` 包装已处理（stats/tasks）。
5. **VARCHAR 主键长度**：UUID 是 36 字符，schema 用 `VARCHAR(36)`。索引列（url 2048、content_hash 64）已适配。
6. **`.env` 含真实 EMBEDDING_API_KEY**（gitignore 忽略），迁移时**不要提交** `.env`。

---

## 六、运行方式（迁移完成后）

```bash
# 1. 装依赖
npm install

# 2. 配 MySQL（.env）
#    MYSQL_HOST/PORT/USER/PASSWORD/DATABASE

# 3. 建表
node --import tsx scripts/migrate.mysql.ts

# 4. 启动（demo 模式无 key 全链可跑）
CI_DEMO_MODE=true npm run api          # 看板 http://localhost:3013
CI_DEMO_MODE=true npm run worker -- --name w1

# 5. 测试（需 MySQL 测试库）
npm test
```

---

## 七、git 提交约定

- 本次提交为 **WIP 快照**：`feat: MySQL 迁移（WIP）— 连接层/查询层异步化 + schema.mysql.sql`（提交时 tsc 未绿，仅存档进度）
- 当前分支 `master`，无远端（或远端未配置）
- 敏感文件（`.env`、`*.sqlite`）已被 `.gitignore` 忽略
