# Production POS + Online Ordering Ecosystem (Shopify)

A complete, production-grade Point-of-Sale and online ordering platform for snack stores, integrating Shopify as the ecommerce backbone with a custom real-time POS, Kitchen Display System (KDS), and admin dashboard.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Customer Layer                               │
│  Next.js Storefront │ Shopify Storefront │ PWA │ Order Tracking  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS / WebSocket
┌──────────────────────────────▼──────────────────────────────────┐
│              API Gateway (Rate Limiting · JWT · TLS)             │
└──────────┬──────────────┬──────────────┬───────────┬────────────┘
           │              │              │           │
    ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼────┐ ┌───▼────────┐
    │Order Service│ │POS Service │ │Inventory│ │Auth Service│
    └──────┬──────┘ └─────┬──────┘ └────┬────┘ └───┬────────┘
           └──────────────┴──────────────┴───────────┘
                               │
        ┌──────────────────────┴─────────────────────┐
        │                                             │
┌───────▼────────┐  ┌─────────────────┐  ┌───────────▼────────┐
│  Socket.IO     │  │  BullMQ Queue   │  │  Shopify Webhooks  │
│  (Redis adapt) │  │  (Retry/CRON)   │  │  (HMAC verified)   │
└───────┬────────┘  └─────────────────┘  └────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│           Data Layer                                          │
│  PostgreSQL (primary + replicas) │ Redis │ S3/R2 │ Prometheus │
└───────────────────────────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│           Store Clients (Socket.IO connected)                 │
│  Cashier POS │ Kitchen Display │ Admin Dashboard │ Reports    │
└──────────────────────────────────────────────────────────────┘
```

---

## Monorepo Structure

```
snackpos/
├── apps/
│   ├── web/          # Next.js customer storefront (mobile-first)
│   ├── pos/          # Next.js cashier POS interface
│   ├── kds/          # Next.js kitchen display system
│   └── admin/        # Next.js admin dashboard
├── packages/
│   ├── types/        # Shared TypeScript types (all services)
│   ├── database/     # Knex migrations + seeds
│   ├── ui/           # Shared component library
│   └── config/       # Shared configuration schemas
├── services/
│   ├── api/          # Express.js REST API + Socket.IO
│   └── workers/      # BullMQ background workers
├── infra/
│   ├── docker/       # Docker Compose (dev + prod)
│   ├── k8s/          # Kubernetes manifests
│   └── terraform/    # Infrastructure as Code
└── .github/
    └── workflows/    # CI/CD pipelines
```

---

## Tech Stack

| Layer            | Technology                      |
| ---------------- | ------------------------------- |
| Monorepo         | Turborepo + pnpm workspaces     |
| Language         | TypeScript (strict) everywhere  |
| Frontend         | Next.js 14 (App Router)         |
| Backend          | Express.js + Node.js 20         |
| Database         | PostgreSQL 16                   |
| Cache/Queue      | Redis 7                         |
| Realtime         | Socket.IO + Redis adapter       |
| Background       | BullMQ workers                  |
| Ecommerce        | Shopify Admin + Storefront APIs |
| Payments         | Stripe + Shopify Payments       |
| Auth             | JWT + RBAC + PIN (POS)          |
| Containerization | Docker + Docker Compose         |
| Orchestration    | Kubernetes (production)         |
| CI/CD            | GitHub Actions                  |
| Monitoring       | Prometheus + Grafana            |

---

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker + Docker Compose

### 2. Configure environment

```bash
cp .env.example services/api/.env
cp .env.example apps/web/.env.local
cp .env.example apps/pos/.env.local
# Edit each .env file with your values
```

### 3. Start infrastructure

```bash
pnpm docker:up
# Starts: PostgreSQL, Redis, Mailhog
```

### 4. Run database migrations

```bash
pnpm db:migrate
pnpm db:seed  # Optional: seed sample data
```

### 5. Start all services

```bash
pnpm dev
# Starts all apps and services in parallel via Turborepo
```

| Service             | URL                   |
| ------------------- | --------------------- |
| Customer Storefront | http://localhost:3000 |
| POS Interface       | http://localhost:3001 |
| Kitchen Display     | http://localhost:3002 |
| Admin Dashboard     | http://localhost:3003 |
| API                 | http://localhost:4000 |
| BullMQ Dashboard    | http://localhost:4001 |
| Mailhog             | http://localhost:8025 |

---

## Key Features

### Customer (Web)

- Mobile-first Next.js storefront
- Shopify Storefront API integration
- Product customization with modifiers
- Pickup / delivery / dine-in selection
- Coupon & promo code support
- Real-time order tracking via WebSocket
- PWA support (offline product browsing)

### Cashier POS

- Touch-optimized interface
- USB barcode scanner (HID keyboard emulation)
- Offline mode with IndexedDB queue
- Auto-sync on reconnect
- Cash + card + mixed payment
- Thermal receipt printing (Star, Epson)
- PIN-based fast login per terminal

### Kitchen Display System (KDS)

- Real-time order stream via Socket.IO
- Item-level status tracking (pending → preparing → ready)
- Configurable 2/3/4 column layout
- Visual + audio alerts for late orders
- Order timer with color escalation (normal → warning → urgent)
- Auto-transition order to READY when all items done

### Admin Dashboard

- Sales analytics with period comparisons
- Revenue/orders/AOV/customer KPIs
- Daily breakdown & hourly heatmaps
- Product & category performance
- Employee performance reports
- Inventory management + alerts
- Multi-store support
- Audit log for all mutations

### Shopify Integration

- Bi-directional webhook sync (orders, products, inventory, customers)
- HMAC verification on all webhooks
- Idempotent webhook processing
- Product catalog sync
- Inventory level sync
- Customer database sync
- Shopify fulfillment sync

---

## Shopify Webhook Topics Handled

| Topic                       | Action                            |
| --------------------------- | --------------------------------- |
| `orders/create`           | Sync new Shopify orders to our DB |
| `orders/updated`          | Sync status changes               |
| `orders/paid`             | Mark order confirmed              |
| `orders/cancelled`        | Cancel + release inventory        |
| `orders/fulfilled`        | Mark delivered                    |
| `orders/refunds/create`   | Create refund record              |
| `products/create`         | Sync new product                  |
| `products/update`         | Update product data               |
| `products/delete`         | Soft-delete product               |
| `inventory_levels/update` | Sync stock levels                 |
| `customers/create`        | Sync new customer                 |
| `customers/update`        | Update customer data              |
| `shop/redact`             | GDPR: delete store data           |
| `customers/redact`        | GDPR: anonymize customer          |

---

## API Endpoints

```
POST   /api/auth/login           # Email/password login
POST   /api/auth/pin-login       # POS PIN login
POST   /api/auth/refresh         # Refresh access token
POST   /api/auth/logout          # Revoke session

GET    /api/orders               # List orders (paginated, filtered)
POST   /api/orders               # Create order
GET    /api/orders/:id           # Get order details
PATCH  /api/orders/:id/status    # Update order status
POST   /api/orders/:id/refund    # Process refund
POST   /api/orders/:id/print     # Print receipt

GET    /api/products             # List products (public)
POST   /api/products             # Create product
GET    /api/products/barcode/:bc # Lookup by barcode
PUT    /api/products/:id         # Update product
DELETE /api/products/:id         # Soft-delete product

GET    /api/inventory            # List inventory
PATCH  /api/inventory/:id/adjust # Adjust stock
GET    /api/inventory/alerts     # Low/out-of-stock alerts

GET    /api/analytics/dashboard  # KPIs for today
GET    /api/analytics/sales-report?start=&end= # Full report

POST   /api/cash-register/open   # Open cash session
POST   /api/cash-register/close  # Close with count

POST   /api/webhooks/shopify     # Shopify webhook receiver
```

---

## Socket.IO Events

### Client → Server

| Event                  | Payload                 | Description                |
| ---------------------- | ----------------------- | -------------------------- |
| `kds:item_preparing` | `{ orderId, itemId }` | Mark item being prepared   |
| `kds:item_ready`     | `{ orderId, itemId }` | Mark item ready            |
| `order:subscribe`    | `{ orderId }`         | Subscribe to order updates |
| `pos:heartbeat`      | `{ posTerminalId }`   | Keep terminal alive        |
| `offline_queue:sync` | `QueuedEvent[]`       | Sync offline operations    |

### Server → Client

| Event                         | Payload                               | Description           |
| ----------------------------- | ------------------------------------- | --------------------- |
| `order:created`             | `{ storeId, order }`                | New order arrived     |
| `order:status_changed`      | `{ orderId, newStatus }`            | Order status update   |
| `order_item:status_changed` | `{ orderId, itemId, newStatus }`    | Item status update    |
| `kds:order`                 | `{ order }`                         | New order for kitchen |
| `inventory:updated`         | `{ variantId, newQuantity, alert }` | Stock level changed   |
| `pos:notification`          | `{ level, title, message }`         | System notification   |

---

## Database Schema Summary

| Table                      | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `stores`                 | Multi-tenant store config + Shopify credentials |
| `employees`              | Staff with roles, PIN hash, permissions         |
| `employee_sessions`      | JWT refresh token sessions                      |
| `categories`             | Hierarchical product categories                 |
| `products`               | Product catalog with Shopify ID mapping         |
| `product_variants`       | Size/flavor/etc. variants                       |
| `modifier_groups`        | Customization groups (toppings, etc.)           |
| `modifiers`              | Individual customization options                |
| `customers`              | Customer database with Shopify sync             |
| `orders`                 | Orders from all channels                        |
| `order_items`            | Line items with modifier snapshots              |
| `payments`               | Payment records (cash/card/Stripe/Shopify)      |
| `refunds`                | Refund records                                  |
| `inventory_items`        | Stock levels per variant per store              |
| `inventory_movements`    | Full audit trail of stock changes               |
| `suppliers`              | Supplier/vendor management                      |
| `coupons`                | Discount codes and promotions                   |
| `cash_register_sessions` | Daily cash register open/close                  |
| `audit_logs`             | Immutable log of all system actions             |
| `offline_queue`          | POS offline operation sync queue                |
| `webhook_events`         | Shopify webhook idempotency log                 |

---

## Offline Mode (POS)

The POS app supports full offline operation:

1. **Detection**: Socket.IO `disconnect` event + `navigator.onLine`
2. **Queue**: Operations stored in IndexedDB (via `useOfflineQueue` hook)
3. **Idempotency**: Every queued event has a UUID idempotency key
4. **Sync**: On reconnect, `offline_queue:sync` socket event batch-uploads
5. **Server-side**: Checked against `offline_queue` table by idempotency key
6. **Result**: Per-event success/failure reported back, failed ops retained for retry

---

## Employee Permissions (RBAC)

| Permission          | Owner | Manager | Cashier | Kitchen | Delivery |
| ------------------- | ----- | ------- | ------- | ------- | -------- |
| orders:read         | ✓    | ✓      | ✓      | ✓      | ✓       |
| orders:write        | ✓    | ✓      | ✓      | ✓      | ✓       |
| orders:cancel       | ✓    | ✓      |         |         |          |
| orders:refund       | ✓    | ✓      |         |         |          |
| products:write      | ✓    | ✓      |         |         |          |
| inventory:write     | ✓    | ✓      |         |         |          |
| reports:read        | ✓    | ✓      |         |         |          |
| employees:write     | ✓    |         |         |         |          |
| settings:write      | ✓    |         |         |         |          |
| cash_register:close | ✓    | ✓      | ✓      |         |          |
| discounts:apply     | ✓    | ✓      | ✓      |         |          |
| suppliers:write     | ✓    | ✓      |         |         |          |

---

## Implementation Roadmap

### Phase 1 — Core Foundation (Weeks 1–3)

- [X] Monorepo setup with Turborepo
- [X] TypeScript shared types package
- [X] PostgreSQL schema + migrations
- [X] Express API with auth middleware
- [X] JWT + PIN authentication
- [X] Order CRUD with transaction safety
- [X] Shopify webhook handlers
- [X] Socket.IO realtime server
- [X] Docker Compose dev environment

### Phase 2 — POS & KDS (Weeks 4–6)

- [X] Cashier POS interface
- [X] Barcode scanner integration
- [X] Offline queue with IndexedDB
- [X] Kitchen Display System
- [X] Order status state machine
- [ ] Thermal printer integration (Star/Epson SDK)
- [ ] Cash register open/close flow
- [ ] PIN login screen

### Phase 3 — Customer Storefront (Weeks 7–9)

- [ ] Next.js storefront with App Router
- [ ] Shopify Storefront API integration
- [ ] Product catalog with modifiers UI
- [ ] Cart & checkout flow
- [ ] Stripe payment integration
- [ ] Order tracking page (real-time)
- [ ] Coupon/promo code UI
- [ ] PWA manifest + service worker

### Phase 4 — Admin & Analytics (Weeks 10–12)

- [ ] Admin dashboard layout
- [ ] Analytics dashboard with charts
- [ ] Sales report export (PDF/CSV)
- [ ] Product management UI
- [ ] Inventory management + adjustments
- [ ] Employee management + permissions
- [ ] Supplier management
- [ ] Audit log viewer

### Phase 5 — Production Hardening (Weeks 13–16)

- [ ] Kubernetes manifests
- [ ] Horizontal pod autoscaling
- [ ] Database connection pooling (PgBouncer)
- [ ] Redis Sentinel / Cluster
- [ ] Sentry error tracking
- [ ] Prometheus + Grafana monitoring
- [ ] Load testing (k6)
- [ ] Security audit
- [ ] Multi-store tenant isolation tests

---

## Production Deployment

### Recommended Stack

- **API**: Railway, Render, or Fly.io (2-4 instances)
- **Workers**: Railway (1-2 instances, no public port)
- **Database**: Neon, Supabase, or RDS PostgreSQL
- **Redis**: Upstash Redis (Serverless) or ElastiCache
- **Storage**: Cloudflare R2 (S3-compatible)
- **CDN**: Cloudflare
- **Monitoring**: Better Stack / Datadog

### Scaling Considerations

1. **Socket.IO**: Redis adapter enables horizontal scaling — all instances share event bus
2. **Workers**: Stateless, scale independently of API
3. **Database**: Read replicas for analytics queries, PgBouncer for connection pooling
4. **Shopify webhooks**: Queue-backed to handle bursts; idempotent by webhook ID
5. **Multi-store**: All queries filtered by `store_id`; consider per-store Redis namespacing at scale

---

## License

MIT
