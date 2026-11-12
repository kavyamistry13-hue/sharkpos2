# SHARKPOS 2

**Modern POS and retail management platform for small businesses.**

SHARKPOS 2 is a commercial, multi-tenant retail management system designed to help small shops manage billing, products, inventory, purchases, suppliers, customers, credit, returns, employees, analytics, and barcode-based workflows from one application.

> **SHARKPOS 2 is a separate project from the original SHARKPOS hackathon version.**

---

## ✨ What SHARKPOS 2 Provides

### 🧾 POS & Billing
- Fast point-of-sale billing
- Server-side transaction processing
- Split payments
- Cash, digital and credit payments
- Hold and resume bills
- Receipt generation
- Accurate money calculations using paise
- Idempotent payment and completion flows

### 📦 Barcode Scanning
- Scan manufacturer barcodes using a phone camera
- USB/Bluetooth barcode scanner support
- Manual barcode entry
- Multiple barcodes per product
- Tenant-specific barcode mappings
- Existing-product detection
- Barcode-based product lookup

### ⚡ Scan & Add Products

Designed for quickly onboarding large product catalogs.

**Workflow:**

```text
Scan barcode
     ↓
Product form opens
     ↓
Enter/check product details
     ↓
Save product
     ↓
Scan next product
     ↓
Repeat
```

The workflow is designed for adding many products without repeatedly navigating through the normal product-management screens.

### 📊 Inventory
- Stock tracking
- Stock adjustments
- Stock receiving
- Partial purchase receiving
- Rejected goods handling
- Restocking workflows
- Inventory movement history
- Low-stock intelligence
- Supplier-linked inventory

### 🛒 Purchases & Suppliers
- Supplier management
- Purchase orders
- Partial receiving
- Supplier terms and history
- Restock recommendations
- Purchase and inventory tracking

### 💳 Udhaar / Credit
- Customer credit ledger
- Outstanding balances
- Aging information
- FIFO payment allocation
- Credit reminders
- WhatsApp click-to-chat reminders

### ↩️ Sales Returns
- Partial returns
- Line-level return quantities
- Concurrency-safe returns
- Prorated refunds
- Refunds across original payment methods
- Returned stock handling
- Damaged/expired goods handling
- Credit ledger adjustment

### 👥 Employees & Roles

Backend-enforced roles include:

- `platform_admin`
- `business_owner`
- `manager`
- `cashier`

Permissions are enforced on the backend rather than relying on frontend visibility.

### 📈 Analytics & Intelligence
- Sales analytics
- Product analytics
- Inventory intelligence
- Supplier intelligence
- Profit tracking
- Action Center
- Risk Center
- Rule-based business intelligence
- AI-assisted features where available

AI features are designed to be optional and should not block core POS operations.

---

# 🔐 Security & Multi-Tenancy

SHARKPOS 2 is designed as a multi-tenant application.

Tenant isolation is enforced through multiple layers, including:

- PostgreSQL Row-Level Security
- Tenant-aware database access
- Composite database relationships
- Backend authorization
- Role-based access control
- Database-rechecked sessions
- Parameterized SQL
- Zod request validation
- Rate limiting
- Security headers
- Strict CORS configuration
- Audit logging
- Refresh-token rotation
- Password hashing
- Append-only financial/audit records
- Backup and restore verification

Security testing has also covered cross-tenant access attempts, role permissions, financial integrity, authentication, API validation, and database-level isolation.

See:

- [`docs/security.md`](docs/security.md)
- [`docs/SECURITY_AUDIT_REPORT.md`](docs/SECURITY_AUDIT_REPORT.md)
- [`docs/DATA_PROTECTION_CHECKLIST.md`](docs/DATA_PROTECTION_CHECKLIST.md)

---

# 🏗️ Tech Stack

### Frontend
- React
- Vite
- Tailwind CSS
- Progressive Web App-ready architecture

### Backend
- Node.js
- Express
- Zod
- JWT authentication
- PostgreSQL

### Database
- PostgreSQL
- Row-Level Security
- Database migrations
- Tenant isolation
- Audit and financial integrity controls

### Barcode
- Native `BarcodeDetector` when available
- `@zxing/browser` fallback
- Camera and hardware scanner workflows

---

# 🚀 Run Locally

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Git

### 1. Clone the repository

```bash
git clone https://github.com/kavyamistry13-hue/sharkpos2.git
cd sharkpos2
```

### 2. Configure PostgreSQL

From the project root:

```bash
psql -U postgres -f database/setup-local.sql
```

This creates the required SHARKPOS 2 database and roles.

### 3. Configure the backend

```bash
cd backend
```

Windows:

```powershell
copy .env.example .env
```

Linux/macOS:

```bash
cp .env.example .env
```

Edit `.env` and configure the local database credentials and required secrets.

### 4. Install backend dependencies

```bash
npm install
```

### 5. Run database migrations

```bash
npm run migrate
```

### 6. Seed development data

```bash
npm run seed
```

> Seed data is intended for local development only.

### 7. Start the backend

```bash
npm start
```

The backend runs on:

```text
http://localhost:4001
```

### 8. Start the frontend

Open another terminal:

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on:

```text
http://localhost:5174
```

Open:

**http://localhost:5174**

---

# 🧪 Testing

Backend tests:

```bash
cd backend
npm test
```

The project currently has a comprehensive backend test suite covering areas including:

- Authentication
- Registration
- Authorization
- Role permissions
- Tenant isolation
- Cross-business access attempts
- Products
- Inventory
- POS transactions
- Payments
- Split payments
- Holds
- Returns
- Credit/Udhaar
- Barcode workflows
- Scan & Add onboarding
- Security controls
- Audit logging
- Backup/restore verification

The current Phase 8.1 milestone reached:

```text
370 backend tests passing
Frontend production build passing
```

---

# 📱 Barcode Product Onboarding

For shops adding hundreds of products, use:

**Products → Scan & Add Products**

A typical workflow is:

```text
Product barcode
      ↓
Phone camera / USB scanner
      ↓
Barcode detected
      ↓
Product form
      ↓
Price + stock + product details
      ↓
Save & Scan Next
      ↓
Next barcode
```

Existing barcodes are detected and linked to the existing product rather than creating duplicate products.

---

# 📁 Project Structure

```text
sharkpos2/
│
├── backend/
│   ├── src/
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── services/
│   │   └── utils/
│   └── tests/
│
├── frontend/
│   └── src/
│       ├── components/
│       ├── hooks/
│       ├── pages/
│       ├── services/
│       └── utils/
│
├── database/
│   ├── migrations/
│   ├── setup-local.sql
│   └── setup-production.sql
│
├── scripts/
│   ├── backup.sh
│   ├── restore.sh
│   └── verify-restore.js
│
├── docs/
│   ├── api.md
│   ├── architecture.md
│   ├── PHASE_8_BARCODE.md
│   ├── PHASE_8_1_SCAN_ADD.md
│   ├── PHASE_9_INVENTORY_OPERATIONS.md
│   ├── PHASE_9_1_WEIGHTED_AVERAGE_COSTING.md
│   ├── security.md
│   ├── SECURITY_AUDIT_REPORT.md
│   ├── DATA_PROTECTION_CHECKLIST.md
│   ├── PILOT_CHECKLIST.md
│   └── PRODUCT_INNOVATION_AUDIT.md
│
└── README.md
```

---

# 📚 Documentation

| Document | Purpose |
|---|---|
| [`api.md`](docs/api.md) | API reference |
| [`architecture.md`](docs/architecture.md) | System architecture |
| [`PHASE_8_BARCODE.md`](docs/PHASE_8_BARCODE.md) | Barcode scanning |
| [`PHASE_8_1_SCAN_ADD.md`](docs/PHASE_8_1_SCAN_ADD.md) | Scan & Add onboarding |
| [`PHASE_9_INVENTORY_OPERATIONS.md`](docs/PHASE_9_INVENTORY_OPERATIONS.md) | Inventory & operations (reorder, batches/FEFO, counts, CSV) |
| [`PHASE_9_1_WEIGHTED_AVERAGE_COSTING.md`](docs/PHASE_9_1_WEIGHTED_AVERAGE_COSTING.md) | Weighted-average costing (roadmap Phase 9.1) |
| [`security.md`](docs/security.md) | Security architecture |
| [`SECURITY_AUDIT_REPORT.md`](docs/SECURITY_AUDIT_REPORT.md) | Security audit |
| [`DATA_PROTECTION_CHECKLIST.md`](docs/DATA_PROTECTION_CHECKLIST.md) | Data protection checklist |
| [`PILOT_CHECKLIST.md`](docs/PILOT_CHECKLIST.md) | Pilot readiness checklist |
| [`PRODUCT_INNOVATION_AUDIT.md`](docs/PRODUCT_INNOVATION_AUDIT.md) | Product innovation review |

---

# 🛡️ Project Isolation

SHARKPOS 2 is intentionally isolated from the original SHARKPOS project.

| | SHARKPOS | SHARKPOS 2 |
|---|---|---|
| Project | Hackathon version | Commercial version |
| Frontend | `5173` | `5174` |
| Backend | `4000` | `4001` |
| Database | `sharkpos` | `sharkpos2` |
| Purpose | Original prototype | Production-oriented platform |

SHARKPOS 2 uses its own database and database roles.

The application also contains safeguards that prevent accidentally connecting to an incorrectly named database.

---

# 🗺️ Roadmap

Planned improvements include:

- Offline-first POS capabilities
- Improved mobile barcode scanning
- More advanced AI forecasting
- Automated product data enrichment
- MFA and password-reset improvements
- Additional deployment and monitoring improvements
- Production recovery rehearsals
- Further security testing

---

# ⚠️ Current Development Notes

SHARKPOS 2 is an actively developed project.

Some advanced features are still being hardened and tested before unrestricted production deployment.

The repository should therefore be treated as a development/controlled-pilot project until the remaining production-readiness checklist is completed.

---

# 🤝 Contributing

Contributions, bug reports, feature ideas, and security feedback are welcome.

Before making changes:

1. Create a branch.
2. Make the smallest focused change possible.
3. Run the backend test suite.
4. Run the frontend production build.
5. Verify tenant isolation for changes involving business data.
6. Do not commit secrets or `.env` files.

---

# 📄 License

License information will be added when the project's licensing decision is finalized.

---

## SHARKPOS 2

**POS • Inventory • Barcode • Credit • Analytics • Intelligence**

Built for modern small-business retail operations.