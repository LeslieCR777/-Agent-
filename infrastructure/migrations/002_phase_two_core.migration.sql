CREATE TABLE IF NOT EXISTS research_projects (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(300) NOT NULL,
  objective TEXT NOT NULL,
  business_context TEXT,
  market VARCHAR(100) NOT NULL,
  channels TEXT NOT NULL,
  topics TEXT NOT NULL,
  source_policy TEXT NOT NULL,
  report_template VARCHAR(50) NOT NULL DEFAULT 'standard',
  alert_policy TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by VARCHAR(100) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  KEY idx_projects_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_members (
  project_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(100) NOT NULL,
  role VARCHAR(30) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (project_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS companies (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(300) NOT NULL,
  website VARCHAR(2048),
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_companies_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS brands (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL,
  name VARCHAR(300) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_brands_company_name (company_id, name),
  KEY idx_brands_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_series (
  id VARCHAR(36) PRIMARY KEY,
  brand_id VARCHAR(36) NOT NULL,
  name VARCHAR(300) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_series_brand_name (brand_id, name),
  KEY idx_series_brand (brand_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS skus (
  id VARCHAR(36) PRIMARY KEY,
  series_id VARCHAR(36) NOT NULL,
  code VARCHAR(200) NOT NULL,
  name VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_skus_series_code (series_id, code),
  KEY idx_skus_series (series_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_skus (
  project_id VARCHAR(36) NOT NULL,
  sku_id VARCHAR(36) NOT NULL,
  side VARCHAR(20) NOT NULL DEFAULT 'competitor',
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (project_id, sku_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_runs (
  project_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (project_id, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  sku_id VARCHAR(36) NOT NULL,
  market VARCHAR(100) NOT NULL,
  channel VARCHAR(100) NOT NULL,
  parameters LONGTEXT NOT NULL,
  source_url VARCHAR(2048),
  evidence_id VARCHAR(36),
  captured_at VARCHAR(40) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_product_timeline (sku_id, market, channel, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS price_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  sku_id VARCHAR(36) NOT NULL,
  market VARCHAR(100) NOT NULL,
  channel VARCHAR(100) NOT NULL,
  list_price DECIMAL(18,4),
  sale_price DECIMAL(18,4),
  currency VARCHAR(10) NOT NULL,
  in_stock TINYINT,
  source_url VARCHAR(2048),
  evidence_id VARCHAR(36),
  captured_at VARCHAR(40) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_price_timeline (sku_id, market, channel, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_imports (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36),
  filename VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'preview',
  mapping TEXT NOT NULL,
  preview LONGTEXT NOT NULL,
  row_count INT NOT NULL,
  duplicate_count INT NOT NULL DEFAULT 0,
  created_by VARCHAR(100) NOT NULL,
  created_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
