# Monitoring

阶段一使用结构化日志、`GET /api/health` 和容器健康检查。生产环境应采集 API、Orchestrator、Worker 的 stdout，并至少配置：服务存活、Outbox 堆积、失败任务数、Worker 心跳超时、MySQL 连接数告警。

队列当前由 MySQL 任务表与事务 Outbox 提供，保证单体阶段的一致性；流量增长后可在不修改 HTTP 契约的前提下替换为 Redis Streams、RabbitMQ 或 Kafka。
