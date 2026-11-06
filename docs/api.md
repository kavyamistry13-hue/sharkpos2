# API reference

Base path `/api`. JSON in and out. Send `Authorization: Bearer <token>` on everything except login and health. Errors: `{ "error": { "code", "message", "details?" } }`.
Roles: **A** admin, **M** manager, **C** cashier.

## Auth
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /health | public | liveness |
| POST | /auth/login | public | `{email,password}` → `{token,user}` (rate limited) |
| GET | /auth/me | all | current user |
| POST | /auth/change-password | all | `{currentPassword,newPassword}` |

## Products
| Method | Path | Roles and notes |
|---|---|---|

| GET | /products | all (list, search, filter) |
| GET | /products/lookups | all (categories, suppliers) |
| GET | /products/pos-search?q= | all |
| GET | /products/:id | A,M |
| POST | /products | A,M |
| PUT | /products/:id | A,M |
| DELETE | /products/:id | A |

## Sales
| Method | Path | Roles and notes |
|---|---|---|

| POST | /sales/preview | all | price a cart, no side effects |
| GET | /sales/limits | all | discount limit for current user |
| POST | /sales | all | create sale; 403 `APPROVAL_REQUIRED` if discount exceeds limit without manager credentials |
| GET | /sales | all (cashier sees own) |
| GET | /sales/:id | all |
| POST | /sales/:id/refund | A,M |

## Inventory
| Method | Path | Roles and notes |
|---|---|---|

| GET | /inventory?filter=low\|out\|over\|fast\|slow\|expiring\|atrisk | A,M |
| GET | /inventory/alerts | A,M |
| GET | /inventory/:productId/movements | A,M |
| GET | /inventory/restock-orders | A,M |
| POST | /inventory/restock-orders/:id/receive | A,M |

## AI (A,M)
| Method | Path | Roles and notes |
|---|---|---|

| GET | /ai/status | whether an LLM is configured |
| GET | /ai/brief | daily brief |
| POST | /ai/copilot | `{question}` → `{answer, facts, source}` |
| GET | /ai/restock | AI restock recommendations with reasons |
| POST | /ai/restock/:productId/approve | `{quantity?}` creates a restock order |
| POST | /ai/restock/:productId/dismiss | |
| GET | /ai/forecast/:productId | forecast detail |

## Analytics
| Method | Path | Roles and notes |
|---|---|---|

| GET | /analytics/overview | dashboard KPIs |
| GET | /analytics/sales?range=today\|7d\|30d\|3m | |
| GET | /analytics/products?range= | |

## Risk
| Method | Path | Roles and notes |
|---|---|---|

| GET | /risk/alerts?status=&severity= | |
| GET | /risk/transactions | |
| GET | /risk/alerts/:id/sale | |
| POST | /risk/alerts/:id/status | `{status: open\|reviewed\|dismissed}` |

## Customers / Employees / Settings
| Method | Path | Roles and notes |
|---|---|---|

| GET | /customers/search?q= | all |
| POST | /customers | all |
| GET | /customers, /customers/:id | A,M |
| GET, POST, PUT | /employees, /employees/:id | A (see route for read access) |
| GET | /settings | all |
| PUT | /settings | A |

## Demo
| Method | Path | Roles and notes |
|---|---|---|

| GET | /demo/status | |
| POST | /demo/load | A, `{confirm:true}`; disabled in production unless `ALLOW_DEMO=true` |
