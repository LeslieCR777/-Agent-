# 阶段二：批次 0–1

本批次交付持续研究项目、产品目录、价格与参数时间线，以及 CSV 导入预览/确认。

## 数据迁移

`npm run migrate:mysql` 会先应用兼容基线，再按文件名顺序执行 `*.migration.sql`。成功版本记录在
`schema_migrations`，重复运行不会再次执行已完成版本。

## 核心入口

- `POST/GET /api/projects`：创建和查询 Research Project。
- `GET /api/projects/:id/dashboard`：SKU 覆盖和价格快照新鲜度。
- `POST /api/projects/:id/members`：项目成员角色。
- `GET /api/catalog`、`POST /api/catalog/items/:type`：完整产品层级。
- `POST /api/catalog/imports/preview`：CSV 映射、预览和重复检测。
- `POST /api/catalog/imports/:id/confirm`：人工确认入库。
- `POST /api/skus/:id/price-snapshots`：保留市场、渠道和原币种价格。
- `POST /api/skus/:id/product-snapshots`：保存参数事实及来源。
- `GET /api/skus/:id/timeline`：筛选价格和参数历史。

CSV 必须映射到 `company`、`brand`、`series`、`sku_code`、`sku_name`。预览不会写入产品目录，
只有确认操作才会入库。

## 回滚

应用迁移前先备份数据库。回滚本批次时停止写入相关 API，导出阶段二表后删除
`002_phase_two_core.migration.sql` 创建的表和对应 `schema_migrations` 记录；阶段一表不受影响。
