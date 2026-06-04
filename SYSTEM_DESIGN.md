# System Design — Financial Risk Assessment API

A chronological, hop-by-hop description of how data flows through the system, for the **POST (Upload)** and **GET (Fetch Risk Assessment)** paths.

---

## Overview

A backend that ingests company financials in bulk and returns risk scores. Bulk uploads are accepted asynchronously through SQS and persisted to DynamoDB by a background worker with idempotency guarantees. Failed records flow through a Dead Letter Queue and are retried by a second worker. Risk-score computation is delegated to a Lambda invoked synchronously on the read path. Stack: Node.js + Express, AWS SQS, DynamoDB, Lambda, Redis (planned).

---

## File-by-file overview

| File | Responsibility |
|---|---|
| `src/server.js` | Entry point. Loads `.env`, starts Express on `PORT`. |
| `src/app.js` | Express setup: `helmet`, `express-rate-limit` (100 req/min/IP), JSON parser, route mounting at `/api/v1/*`. |
| `src/config/db.js` | DynamoDB DocumentClient singleton. |
| `src/controllers/authcontroller.js` | JWT auth middleware. Verifies token, attaches `user_id` to `req`. |
| `src/controllers/userController.js` | Register / login / profile / logout. bcrypt password hashing, JWT issuance, lookup via `email-index` GSI. |
| `src/controllers/financialController.js` | `uploadFinancialData` (POST), `getBatchStatus`, `getRiskAssessment` (GET — DynamoDB → Lambda). |
| `src/models/userModel.js` | DynamoDB wrappers for user CRUD. |
| `src/routes/userRoute.js` | `/api/v1/user/*` routes. |
| `src/routes/financialRoute.js` | `/api/v1/finance/*` routes. All protected by JWT middleware. |
| `src/workers/sqsWorker.js` | Long-running consumer of the main SQS queue. Reads messages → `transactWrite` to DynamoDB with `ConditionExpression` for idempotency → on failure, explodes records into the DLQ. |
| `src/workers/dlqWorker.js` | Long-running consumer of the DLQ. Per record: `GetItem` existence pre-check → if exists, delete from DLQ; else retry conditional `Put`. |

Three runnable processes: **API server**, **SQS worker**, **DLQ worker** — all independent and stateless.

---

# 1. POST `/api/v1/finance/uploadFinancialData`

## Diagram

```
                                         ┌──────────────────────────────┐
                                         │ DynamoDB: BATCH              │
                                         │   PK = batch_id              │
                                         │   { total, success, failed,  │
                                         │     status }                 │
                                         └──────────────────────────────┘
                                                    ▲   ▲
                                                    │   │  (4) update counters
                                                    │   │      + status=Completed
   ┌────────┐ POST /uploadFinancialData             │   │
   │ Client │───────────────────────────────────────┤   │
   └────────┘  JSON: [ {company_id,                 │   │
       ▲          reporting_period, ...}, ... ]    (1)  │
       │                                            │   │
       │ 202 Accepted                               │   │
       │ { batch_id }                               │   │
       │                                            │   │
       │                            ┌───────────────┴─┐ │      ┌─────────────────┐
       └────────────────────────────│ Express API     │ │      │ DynamoDB:       │
                                    │ - JWT auth      │ │      │ FINANCIAL       │
                                    │ - rate limit    │ │      │   PK=company_id │
                                    │ - validate      │ │      │   SK=reporting_ │
                                    │ - create batch  │ │      │      period     │
                                    │   row (1)      │ │      │   GSI=Industry  │
                                    │ - sendMessage  (2)│      │      SectorIdx  │
                                    └────────┬────────┘ │      └────────▲────────┘
                                             │          │               │
                                             ▼          │               │ (3) transactWrite
                                        ┌─────────┐     │               │     with
                                        │ SQS     │     │               │     ConditionExpression
                                        │ MAIN    │─poll┼─►┌──────────┐ │     attribute_not_exists
                                        │ queue   │     │  │ sqsWorker│─┘
                                        └─────────┘     │  └────┬─────┘
                                             ▲          │       │
                                             │          │       │ on transaction
                                       on uncaught      │       │ failure: explode
                                       crash: SQS       │       │ records → DLQ
                                       redrive after    │       ▼
                                       N receives       │  ┌─────────┐
                                             │          │  │ SQS DLQ │
                                             └──────────┼──┤         │
                                                        │  └────┬────┘
                                                        │       │ poll
                                                        │       ▼
                                                        │  ┌──────────┐
                                                        │  │dlqWorker │
                                                        │  │ - GetItem│
                                                        │  │   check  │
                                                        │  │ - retry  │
                                                        │  │   Put    │
                                                        │  └──────────┘
                                                        │       │
                                                        │       │ on success
                                                        └───────┘ writes to FINANCIAL
```

## Chronological flow

### Step 1 — Request arrives (synchronous, < 200 ms)
1. Client POSTs `[ { company_id, reporting_period, industry_sector, total_assets, total_liabilities, revenue, net_profit, cash_flow }, ... ]`.
2. Middleware chain: `helmet` → `express-rate-limit` → JSON parse → JWT auth.
3. Controller mints `batch_id = batch-${Date.now()}`, writes a row to `BATCH` with `status=Processing`, and tags every record with that `batch_id`.
4. The enriched array is sent as **one** SQS message via `sqs.sendMessage`.
5. Server returns **202 Accepted** with `batch_id` and a status endpoint.

### Step 2 — Queue (SQS)
`sqsWorker.js` polls SQS in a loop:
```js
while (true) {
  receiveMessage({ MaxNumberOfMessages: 10, WaitTimeSeconds: 5 })
}
```
- **Standard queue** (not FIFO). At-least-once delivery; duplicates handled at the DB layer.
- **Long polling** via `WaitTimeSeconds: 5` — SQS holds the connection up to 5 s waiting for messages.
- **Visibility timeout** (default 30 s) hides the message from other consumers between `receiveMessage` and `deleteMessage`. If the worker fails to delete in time, the message reappears.

### Step 3 — Worker writes to DynamoDB (idempotent transactional write)
```js
TransactItems: records.map(r => ({
  Put: {
    TableName: FINANCIAL_TABLE,
    Item: { id: uuid(), batch_id, ...r, createdAt },
    ConditionExpression:
      "attribute_not_exists(company_id) AND attribute_not_exists(reporting_period)"
  }
}))
```
- Composite primary key: PK = `company_id`, SK = `reporting_period`. Enforces one row per company per reporting period.
- `ConditionExpression` makes the insert idempotent: a redelivered SQS message fails the condition atomically.
- `TransactWriteItems` is all-or-nothing. DynamoDB uses a two-phase commit; transactions cost 2× the write capacity of a regular write and are capped at 100 items / 4 MB.
- On success: update the `BATCH` row counters and `status=Completed`, then `deleteMessage` from SQS.
- On failure: each record in the batch is sent to the DLQ as its own message, then the original SQS message is deleted.

### Step 4 — DLQ worker (recovery)
```js
const exists = await recordExists(company_id, reporting_period);
if (exists) { deleteMessage(); return; }   // already written — drop
// else retry the conditional Put
```
The pre-check exists because `transactWrite` is all-or-nothing — a single duplicate in a batch fails all items, so the DLQ can legitimately contain records that already exist in DB (e.g. when a previous run's `deleteMessage` failed after a successful write). `GetItem` (0.5 RCU) before a retried conditional `Put` (1 WCU on failure) is the cheaper path when duplicate rate in the DLQ is high.

## Deduplication strategy

- No SQS `MessageId` deduplication, no Redis dedup table.
- Deduplication is on the natural business key `(company_id, reporting_period)` enforced by DynamoDB's `ConditionExpression`.
- This catches SQS redelivery and client-side resubmission with different MessageIds, with no extra storage.

## DynamoDB schema (write path)

| Table | PK | SK | GSI | Purpose |
|---|---|---|---|---|
| `BATCH` | `batch_id` | — | — | Async-progress tracking for clients |
| `FINANCIAL` | `company_id` | `reporting_period` | `IndustrySectorIndex` (PK = `industry_sector`) | Persisted financial records |
| `USERS` | `user_id` | — | `email-index` (PK = `email`) | Accounts |

---

# 2. GET `/api/v1/finance/getRiskAssessment`

## Diagram

```
   ┌────────┐ GET /getRiskAssessment?company_id=&reporting_period=&industry_sector=
   │ Client │────────────────────────────────────────┐
   └────▲───┘                                        │
        │                                            ▼
        │              ┌──────────────────────────────────────┐
        │              │ Express API                          │
        │              │ - JWT auth                           │
        │              │ - choose access pattern from params: │
        │              │     company_id → Query on PK         │
        │              │     industry_sector → Query on GSI   │
        │              │     reporting_period only → Scan     │
        │              └─────────────┬────────────────────────┘
        │                            │
        │                            ▼
        │              ┌──────────────────────────────────────┐
        │              │ DynamoDB: FINANCIAL                  │
        │              │   PK=company_id, SK=reporting_period │
        │              │   GSI: IndustrySectorIndex            │
        │              └─────────────┬────────────────────────┘
        │                            │ rows (independent fields)
        │                            ▼
        │              ┌──────────────────────────────────────┐
        │              │ AWS Lambda: risk-scoring             │
        │              │ invoke(RequestResponse) — sync       │
        │              │ computes dependent fields:           │
        │              │   debt_to_asset_ratio,               │
        │              │   debt_to_equity_ratio,              │
        │              │   profit_margin, return_on_assets,   │
        │              │   cash_flow_ratio, equity,           │
        │              │   risk_score, risk_level             │
        │              └─────────────┬────────────────────────┘
        │                            │
        │       JSON enriched rows   │
        └────────────────────────────┘
```

## Chronological flow

### Step 1 — Request and access-pattern selection
1. JWT auth middleware.
2. Controller inspects query params and selects one DynamoDB access pattern:
   - `company_id` (± `reporting_period`) → `Query` on the primary key.
   - `industry_sector` → `Query` on the `IndustrySectorIndex` GSI.
   - `reporting_period` alone → full-table `Scan` with `FilterExpression`.
   - `industry_sector` + `reporting_period` → `Query` on the GSI with a `FilterExpression` for the period.

### Step 2 — Read from DynamoDB
- Rows are returned with all independent (stored) fields populated.
- GSIs are eventually consistent — a base-table write propagates asynchronously to the GSI.

### Step 3 — Lambda invocation (compute dependent fields)
```js
lambda.invoke({
  FunctionName: LAMBDA_RISK_FUNCTION,
  InvocationType: "RequestResponse",     // synchronous
  Payload: JSON.stringify({ records: result.Items })
})
```
Lambda receives the full rows and returns them enriched with dependent fields. Pure compute, no I/O.

### Step 4 — Return enriched JSON
Controller unwraps the Lambda response (`JSON.parse(Payload).body` → `JSON.parse(...)` — Lambda follows the API Gateway proxy response shape) and returns the enriched rows as `data`.

## Field model

**Independent fields** (client-supplied, stored in `FINANCIAL`):
- `company_id`, `company_name`, `reporting_period`, `industry_sector`
- `total_assets`, `total_liabilities`, `revenue`, `net_profit`, `cash_flow`

**Dependent fields** (computed in Lambda on every read, never stored):
- `equity` = `total_assets − total_liabilities`
- `debt_to_asset_ratio` = `total_liabilities / total_assets`
- `debt_to_equity_ratio` = `total_liabilities / equity`
- `profit_margin` = `net_profit / revenue`
- `return_on_assets` = `net_profit / total_assets`
- `cash_flow_ratio` = `cash_flow / total_liabilities`
- `risk_score` — weighted composite of the ratios above
- `risk_level` — `LOW` / `MEDIUM` / `HIGH` bucket derived from `risk_score`

Dependent fields are derived on read so the risk formula can change without a backfill.

---

Redis is scaffolded in the codebase and intended as a future cache-aside layer in front of DynamoDB for the `/batch-status` and risk-score read paths.
