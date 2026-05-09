-- SnackPOS Complete Database Schema
-- PostgreSQL 15+
-- Run with: psql -d snackpos -f 001_initial_schema.sql

-- ─── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- ─── Enums ─────────────────────────────────────────────────────────────────────
CREATE TYPE order_status AS ENUM (
  'PENDING','CONFIRMED','PREPARING','READY',
  'OUT_FOR_DELIVERY','DELIVERED','PICKED_UP','CANCELLED','REFUNDED'
);
CREATE TYPE order_type AS ENUM ('ONLINE','POS','SHOPIFY');
CREATE TYPE fulfillment_type AS ENUM ('PICKUP','DELIVERY','DINE_IN');
CREATE TYPE payment_status AS ENUM (
  'PENDING','AUTHORIZED','CAPTURED','PARTIALLY_REFUNDED','REFUNDED','FAILED','VOIDED'
);
CREATE TYPE payment_method AS ENUM ('CASH','CARD','STRIPE','SHOPIFY','MIXED');
CREATE TYPE employee_role AS ENUM ('OWNER','MANAGER','CASHIER','KITCHEN','DELIVERY');
CREATE TYPE inventory_movement_type AS ENUM (
  'PURCHASE','SALE','ADJUSTMENT','TRANSFER','WASTE','RETURN','INITIAL_STOCK'
);
CREATE TYPE audit_action AS ENUM (
  'CREATE','UPDATE','DELETE','REFUND','CANCEL',
  'LOGIN','LOGOUT','CASH_CLOSE','DISCOUNT_APPLIED'
);
CREATE TYPE order_item_status AS ENUM ('PENDING','PREPARING','READY','SERVED','CANCELLED');
CREATE TYPE coupon_type AS ENUM ('PERCENTAGE','FIXED_AMOUNT','FREE_SHIPPING','BUY_X_GET_Y');

-- ─── Stores ────────────────────────────────────────────────────────────────────
CREATE TABLE stores (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  phone                 TEXT,
  email                 TEXT NOT NULL,
  timezone              TEXT NOT NULL DEFAULT 'America/Mexico_City',
  currency              TEXT NOT NULL DEFAULT 'MXN',
  logo_url              TEXT,
  shopify_shop_domain   TEXT UNIQUE,
  shopify_access_token  TEXT,
  shopify_webhook_secret TEXT,
  address               JSONB NOT NULL DEFAULT '{}',
  settings              JSONB NOT NULL DEFAULT '{}',
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stores_slug ON stores(slug);
CREATE INDEX idx_stores_shopify_domain ON stores(shopify_shop_domain) WHERE shopify_shop_domain IS NOT NULL;

-- ─── Employees ─────────────────────────────────────────────────────────────────
CREATE TABLE employees (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id      UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  role          employee_role NOT NULL DEFAULT 'CASHIER',
  pin_hash      TEXT NOT NULL,
  permissions   TEXT[] NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE(store_id, email)
);

CREATE INDEX idx_employees_store ON employees(store_id);
CREATE INDEX idx_employees_email ON employees(email);

-- ─── Employee Sessions ─────────────────────────────────────────────────────────
CREATE TABLE employee_sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  device_info JSONB,
  ip_address  INET,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employee_sessions_token ON employee_sessions(token_hash);
CREATE INDEX idx_employee_sessions_employee ON employee_sessions(employee_id);

-- ─── Categories ────────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  image_url   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE(store_id, slug)
);

CREATE INDEX idx_categories_store ON categories(store_id);
CREATE INDEX idx_categories_parent ON categories(parent_id) WHERE parent_id IS NOT NULL;

-- ─── Products ──────────────────────────────────────────────────────────────────
CREATE TABLE products (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
  shopify_product_id  TEXT,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  description         TEXT,
  image_urls          TEXT[] NOT NULL DEFAULT '{}',
  base_price          NUMERIC(12,2) NOT NULL DEFAULT 0,
  compare_at_price    NUMERIC(12,2),
  sku                 TEXT,
  barcode             TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  is_featured         BOOLEAN NOT NULL DEFAULT false,
  track_inventory     BOOLEAN NOT NULL DEFAULT true,
  allow_backorder     BOOLEAN NOT NULL DEFAULT false,
  tags                TEXT[] NOT NULL DEFAULT '{}',
  metafields          JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ,
  UNIQUE(store_id, slug)
);

CREATE INDEX idx_products_store ON products(store_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_shopify ON products(shopify_product_id) WHERE shopify_product_id IS NOT NULL;
CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_tags ON products USING gin(tags);
CREATE INDEX idx_products_search ON products USING gin(
  to_tsvector('english', name || ' ' || COALESCE(description,'') || ' ' || array_to_string(tags,' '))
);

-- ─── Product Variants ──────────────────────────────────────────────────────────
CREATE TABLE product_variants (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shopify_variant_id   TEXT,
  name                 TEXT NOT NULL,
  sku                  TEXT,
  barcode              TEXT,
  price                NUMERIC(12,2) NOT NULL,
  compare_at_price     NUMERIC(12,2),
  weight               NUMERIC(10,3),
  weight_unit          TEXT,
  image_url            TEXT,
  inventory_quantity   INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold  INTEGER NOT NULL DEFAULT 5,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  options              JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_variants_shopify ON product_variants(shopify_variant_id) WHERE shopify_variant_id IS NOT NULL;
CREATE INDEX idx_variants_barcode ON product_variants(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_variants_sku ON product_variants(sku) WHERE sku IS NOT NULL;

-- ─── Modifier Groups & Modifiers ───────────────────────────────────────────────
CREATE TABLE modifier_groups (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  required       BOOLEAN NOT NULL DEFAULT false,
  min_selections INTEGER NOT NULL DEFAULT 0,
  max_selections INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modifier_groups_product ON modifier_groups(product_id);

CREATE TABLE modifiers (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id              UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  inventory_variant_id  UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  price_adjustment      NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modifiers_group ON modifiers(group_id);

-- ─── Customers ─────────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id             UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_customer_id  TEXT,
  first_name           TEXT NOT NULL DEFAULT '',
  last_name            TEXT NOT NULL DEFAULT '',
  email                TEXT,
  phone                TEXT,
  default_address      JSONB,
  loyalty_points       INTEGER NOT NULL DEFAULT 0,
  total_orders         INTEGER NOT NULL DEFAULT 0,
  total_spent          NUMERIC(12,2) NOT NULL DEFAULT 0,
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  notes                TEXT,
  accepts_marketing    BOOLEAN NOT NULL DEFAULT false,
  last_order_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_store ON customers(store_id);
CREATE INDEX idx_customers_email ON customers(store_id, email) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_phone ON customers(store_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_shopify ON customers(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL;

-- ─── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id              UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_number          TEXT NOT NULL,
  shopify_order_id      TEXT,
  shopify_order_name    TEXT,
  status                order_status NOT NULL DEFAULT 'PENDING',
  type                  order_type NOT NULL DEFAULT 'ONLINE',
  fulfillment_type      fulfillment_type NOT NULL DEFAULT 'PICKUP',
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  delivery_address      JSONB,
  subtotal              NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  delivery_fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  tip                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes                 TEXT,
  internal_notes        TEXT,
  coupon_code           TEXT,
  table_number          TEXT,
  pos_terminal_id       TEXT,
  assigned_employee_id  UUID REFERENCES employees(id) ON DELETE SET NULL,
  scheduled_at          TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,
  preparing_at          TIMESTAMPTZ,
  ready_at              TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancelled_reason      TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, order_number)
);

CREATE INDEX idx_orders_store ON orders(store_id);
CREATE INDEX idx_orders_status ON orders(store_id, status);
CREATE INDEX idx_orders_shopify ON orders(shopify_order_id) WHERE shopify_order_id IS NOT NULL;
CREATE INDEX idx_orders_customer ON orders(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_orders_created ON orders(store_id, created_at DESC);
CREATE INDEX idx_orders_number ON orders(store_id, order_number);

-- ─── Order Items ───────────────────────────────────────────────────────────────
CREATE TABLE order_items (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id            UUID REFERENCES products(id) ON DELETE SET NULL,
  variant_id            UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  shopify_line_item_id  TEXT,
  name                  TEXT NOT NULL,
  variant_name          TEXT,
  sku                   TEXT,
  quantity              INTEGER NOT NULL DEFAULT 1,
  unit_price            NUMERIC(12,2) NOT NULL,
  discount_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(12,2) NOT NULL,
  modifiers             JSONB NOT NULL DEFAULT '[]',
  notes                 TEXT,
  status                order_item_status NOT NULL DEFAULT 'PENDING',
  prepared_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id) WHERE product_id IS NOT NULL;

-- ─── Payments ──────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id                  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method                    payment_method NOT NULL,
  status                    payment_status NOT NULL DEFAULT 'PENDING',
  amount                    NUMERIC(12,2) NOT NULL,
  currency                  TEXT NOT NULL DEFAULT 'MXN',
  stripe_payment_intent_id  TEXT,
  shopify_transaction_id    TEXT,
  cash_tendered             NUMERIC(12,2),
  cash_change               NUMERIC(12,2),
  metadata                  JSONB NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_order ON payments(order_id);

-- ─── Refunds ───────────────────────────────────────────────────────────────────
CREATE TABLE refunds (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id          UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount              NUMERIC(12,2) NOT NULL,
  reason              TEXT NOT NULL,
  stripe_refund_id    TEXT,
  shopify_refund_id   TEXT,
  processed_by        UUID NOT NULL REFERENCES employees(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refunds_order ON refunds(order_id);

-- ─── Inventory Items ───────────────────────────────────────────────────────────
CREATE TABLE inventory_items (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  variant_id          UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  supplier_id         UUID,
  quantity            INTEGER NOT NULL DEFAULT 0,
  reserved_quantity   INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  reorder_point       INTEGER NOT NULL DEFAULT 10,
  reorder_quantity    INTEGER NOT NULL DEFAULT 50,
  cost_price          NUMERIC(12,2),
  location            TEXT,
  expires_at          TIMESTAMPTZ,
  last_counted_at     TIMESTAMPTZ,
  alerts              TEXT[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, variant_id)
);

CREATE INDEX idx_inventory_store ON inventory_items(store_id);
CREATE INDEX idx_inventory_variant ON inventory_items(variant_id);
CREATE INDEX idx_inventory_low_stock ON inventory_items(store_id, quantity) 
  WHERE quantity <= low_stock_threshold;

-- ─── Inventory Movements ───────────────────────────────────────────────────────
CREATE TABLE inventory_movements (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type                inventory_movement_type NOT NULL,
  quantity            INTEGER NOT NULL,
  reason              TEXT NOT NULL,
  reference_id        UUID,
  reference_type      TEXT,
  employee_id         UUID NOT NULL REFERENCES employees(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_movements_inventory ON inventory_movements(inventory_item_id);
CREATE INDEX idx_movements_store_date ON inventory_movements(store_id, created_at DESC);

-- ─── Suppliers ─────────────────────────────────────────────────────────────────
CREATE TABLE suppliers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id      UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  address       JSONB,
  payment_terms TEXT,
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_suppliers_store ON suppliers(store_id);

-- Backfill supplier FK on inventory_items
ALTER TABLE inventory_items
  ADD CONSTRAINT fk_inventory_supplier
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;

-- ─── Coupons ───────────────────────────────────────────────────────────────────
CREATE TABLE coupons (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id                  UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_coupon_id         TEXT,
  code                      TEXT NOT NULL,
  description               TEXT,
  type                      coupon_type NOT NULL DEFAULT 'PERCENTAGE',
  value                     NUMERIC(12,2) NOT NULL,
  minimum_order_amount      NUMERIC(12,2),
  maximum_discount_amount   NUMERIC(12,2),
  usage_limit               INTEGER,
  usage_count               INTEGER NOT NULL DEFAULT 0,
  per_customer_limit        INTEGER,
  starts_at                 TIMESTAMPTZ,
  expires_at                TIMESTAMPTZ,
  applicable_product_ids    UUID[] NOT NULL DEFAULT '{}',
  applicable_category_ids   UUID[] NOT NULL DEFAULT '{}',
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, code)
);

CREATE INDEX idx_coupons_store ON coupons(store_id);
CREATE INDEX idx_coupons_code ON coupons(store_id, code);

-- ─── Cash Register Sessions ────────────────────────────────────────────────────
CREATE TABLE cash_register_sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id          UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  pos_terminal_id   TEXT NOT NULL,
  employee_id       UUID NOT NULL REFERENCES employees(id),
  opened_by         UUID NOT NULL REFERENCES employees(id),
  closed_by         UUID REFERENCES employees(id),
  opening_float     NUMERIC(12,2) NOT NULL DEFAULT 0,
  closing_float     NUMERIC(12,2),
  expected_cash     NUMERIC(12,2),
  variance          NUMERIC(12,2),
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  cash_sales        NUMERIC(12,2) NOT NULL DEFAULT 0,
  card_sales        NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  discounts_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  orders_count      INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cash_sessions_store ON cash_register_sessions(store_id);
CREATE INDEX idx_cash_sessions_date ON cash_register_sessions(store_id, opened_at DESC);

-- ─── Audit Logs ────────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  employee_id     UUID REFERENCES employees(id) ON DELETE SET NULL,
  action          audit_action NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  previous_value  JSONB,
  new_value       JSONB,
  ip_address      INET,
  user_agent      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_store_date ON audit_logs(store_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs(store_id, resource_type, resource_id);
CREATE INDEX idx_audit_employee ON audit_logs(employee_id) WHERE employee_id IS NOT NULL;

-- ─── Offline Queue ─────────────────────────────────────────────────────────────
CREATE TABLE offline_queue (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  pos_terminal_id TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  payload         JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  processed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(idempotency_key)
);

CREATE INDEX idx_offline_queue_store ON offline_queue(store_id, processed_at NULLS FIRST);

-- ─── Webhook Events Log ────────────────────────────────────────────────────────
CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id        UUID REFERENCES stores(id) ON DELETE CASCADE,
  source          TEXT NOT NULL, -- 'shopify', 'stripe', etc.
  topic           TEXT NOT NULL,
  shopify_id      TEXT,
  payload         JSONB NOT NULL,
  signature       TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  processed_at    TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_events_store ON webhook_events(store_id, created_at DESC);
CREATE INDEX idx_webhook_events_status ON webhook_events(status, created_at);

-- ─── Functions & Triggers ──────────────────────────────────────────────────────

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
    WHERE column_name = 'updated_at' AND table_schema = 'public'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      t, t
    );
  END LOOP;
END;
$$;

-- Auto-generate order numbers
CREATE SEQUENCE order_number_seq START 1000;

CREATE OR REPLACE FUNCTION generate_order_number(store_slug TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN UPPER(LEFT(store_slug, 3)) || '-' || LPAD(nextval('order_number_seq')::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- Inventory: update available quantity trigger
CREATE OR REPLACE FUNCTION update_inventory_alerts()
RETURNS TRIGGER AS $$
BEGIN
  -- Update alerts based on quantity
  NEW.alerts = ARRAY[]::TEXT[];
  IF NEW.quantity <= 0 THEN
    NEW.alerts = NEW.alerts || 'OUT_OF_STOCK';
  ELSIF NEW.quantity <= NEW.low_stock_threshold THEN
    NEW.alerts = NEW.alerts || 'LOW_STOCK';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_alerts
BEFORE INSERT OR UPDATE OF quantity ON inventory_items
FOR EACH ROW EXECUTE FUNCTION update_inventory_alerts();

-- ─── Seed: Default store ───────────────────────────────────────────────────────
-- (Run separately in seed script)
