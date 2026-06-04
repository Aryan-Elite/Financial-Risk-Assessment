# System Design — Financial Risk Assessment API

A chronological, hop-by-hop explanation of how data flows through the system, for both the **POST (Upload)** and **GET (Fetch Risk Assessment)** paths.

---

## TL;DR

> Backend that ingests company financials in bulk and returns risk scores. The interesting part isn't the math — that's offloaded to a Lambda — it's the ingestion pipeline: how we accept big batches without blocking the client, how we guarantee we never insert the same company-period twice, and how we recover from partial failures via a DLQ. Stack: Node/Express, AWS SQS, DynamoDB, Lambda. Redis is wired in for caching the `batch-status` hot path as the next step.

---

## File-by-file overview

| File | Responsibility |
|---|---|
| `src/server.js` | Entry point. Loads `.env`, starts Express on `PORT`. |
| `src/app.js` | Express setup: `helmet`, `express-rate-limit` (100 req/min/IP), JSON parser, route mounting at `/api/v1/*`. |
| `src/config/db.js` | DynamoDB DocumentClient singleton (region + creds from env). |
| `src/config/redis.js` | ioredis client connecting to `127.0.0.1:6379`. Currently connected but not yet used for reads/writes. |
| `src/controllers/authcontroller.js` | JWT auth middleware. Reads token from `Authorization` header or cookie, verifies with `JWT_SECRET`, attaches `user_id` to `req`. |
| `src/controllers/userController.js` | Register / login / profile / logout. Hashes passwords with bcrypt, issues JWTs, queries `frisk_users` table via the `email-index` GSI for login. |
| `src/controllers/financialController.js` | The interesting one. `uploadFinancialData` (POST), `getBatchStatus`, `getRiskAssessment` (GET — DynamoDB → Lambda). |
| `src/models/userModel.js` | Thin DynamoDB wrappers for user CRUD. |
| `src/routes/userRoute.js` | `/api/v1/user/*` route definitions. |
| `src/routes/financialRoute.js` | `/api/v1/finance/*` route definitions. All protected by `authcontroller.isAuthenticated`. |
| `src/workers/sqsWorker.js` | Long-running consumer of the main SQS queue. Pulls messages → `transactWrite` to DynamoDB with `ConditionExpression` for idempotency → on failure, explodes records into the DLQ. |
| `src/workers/dlqWorker.js` | Long-running consumer of the DLQ. Per failed record: `GetItem` existence pre-check → if exists, delete from DLQ; else retry conditional `Put`. |

The three runnable processes are: **the API server**, **the SQS worker**, **the DLQ worker** — all independent, all stateless.

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

## Why it's shaped like this

- **The client gets 202 in <200 ms.** A batch could be thousands of rows; we don't want the HTTP connection holding the work. The API does three cheap things — auth, create a `BATCH` tracking row, push records onto SQS — and returns a `batch_id`. The client polls `/batch-status` for progress.
- **The worker is the only thing that touches `FINANCIAL`.** That's the heavy table, and the conditional write is what guarantees idempotency. Isolating writes to one consumer keeps the API stateless and horizontally scalable.
- **Failures don't disappear.** Anything the worker can't commit gets exploded into the DLQ as per-record messages. A second worker drains the DLQ with a `GetItem`-then-retry pattern. Nothing is silently lost.

## Chronological narrative

### Act 1 — A request arrives (synchronous, < 200 ms)
1. Client POSTs `[ { company_id, reporting_period, industry_sector, total_assets, total_liabilities, revenue, net_profit, cash_flow }, ... ]`.
2. Middleware: `helmet` → `express-rate-limit` → JSON parse → JWT auth.
3. Controller mints `batch_id = batch-${Date.now()}`, writes a row to `BATCH` with `status=Processing`, tags every record with that `batch_id`.
4. The whole enriched array goes into **one** SQS message via `sqs.sendMessage`.
5. Server returns **202 Accepted** with `batch_id` and a status endpoint.

### Act 2 — The queue (SQS internals)
`sqsWorker.js` is a separate long-running Node process polling SQS:
```js
while (true) {
  receiveMessage({ MaxNumberOfMessages: 10, WaitTimeSeconds: 5 })
}
```
- **Long polling** (`WaitTimeSeconds: 5`): SQS holds the connection up to 5s waiting for messages. Cuts empty-receive cost; avoids the false-empty problem of short polling.
- **Visibility timeout** is the heart of at-least-once delivery. After `receiveMessage`, SQS hides the message; if you `deleteMessage` in time it's gone, otherwise it reappears. This is exactly why idempotency is required downstream.
- **At-least-once, not exactly-once.** Standard queue. Duplicates are possible by design — we handle them at the DB layer.
- **Standard queue, not FIFO** — ordering doesn't matter (each batch is independent), and standard gives much higher throughput.

### Act 3 — Worker writes to DynamoDB (the idempotency story)
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
- Composite primary key — PK = `company_id`, SK = `reporting_period` — enforces "one row per company per period."
- The `ConditionExpression` is the idempotency guard. If SQS redelivers the same message, the second `transactWrite` fails the condition. Atomic, no race.
- `TransactWriteItems` is **all-or-nothing** across the batch. DynamoDB implements this with a two-phase commit, so transactions cost 2× the write capacity of a regular write, capped at 100 items / 4 MB.
- On success: update the `BATCH` row counters and `status=Completed`, then `deleteMessage`.
- On failure: loop each record into the DLQ as its own message, then delete the original. The batch is "exploded" so the DLQ worker can retry rows individually.

### Act 4 — DLQ worker (recovery)
```js
const exists = await recordExists(company_id, reporting_period);
if (exists) { deleteMessage(); return; }   // duplicate — silently drop
// else retry the conditional Put
```
Why the explicit `GetItem` on top of the conditional write?
1. **Cleanup.** If the original transaction succeeded but the `deleteMessage` failed, SQS redrove the message into the DLQ. The row already exists. The pre-check lets us drop the DLQ message confidently.
2. **Cost.** A `GetItem` is 0.5 RCU. A failed conditional write is 1 WCU. Read-then-write is cheaper than write-and-hope when the duplicate rate in DLQ is high.

Also worth knowing: because `transactWrite` is all-or-nothing, a single duplicate within a batch fails the entire batch. So the DLQ can legitimately contain records that already exist in DB.

## Deduplication strategy

- **No SQS `MessageId` dedup, no Redis dedup table.**
- Dedup is on the **natural business key** `(company_id, reporting_period)` via DynamoDB's `ConditionExpression`.
- This is stronger than `MessageId` dedup — it catches SQS redelivery *and* client-side resubmission with different MessageIds, with zero extra storage.

## Known gaps (volunteer in interview)

- DLQ worker has no exponential backoff and no max-retry-count — a poison message sits forever. Production: track attempt count via SQS message attributes, after N attempts move to a `failed_permanent` DynamoDB table for human triage.
- Visibility timeout not explicitly set on either queue (relies on default 30 s).
- Batch sent as one SQS message — one failure dumps the whole batch into the DLQ. Production: chunk to 25 rows per message (DynamoDB transactWrite cap).

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
        │              │     reporting_period only → Scan ⚠  │
        │              └─────────────┬────────────────────────┘
        │                            │
        │                            ▼
        │              ┌──────────────────────────────────────┐
        │              │ DynamoDB: FINANCIAL                  │
        │              │   PK=company_id, SK=reporting_period │
        │              │   GSI: IndustrySectorIndex            │
        │              └─────────────┬────────────────────────┘
        │                            │ rows
        │                            ▼
        │              ┌──────────────────────────────────────┐
        │              │ AWS Lambda: risk-scoring             │
        │              │ invoke(RequestResponse) — sync       │
        │              │ computes debt-ratio, profit-margin,  │
        │              │ ROA, cash-flow ratio, composite      │
        │              │ risk_score + risk_level              │
        │              └─────────────┬────────────────────────┘
        │                            │
        │       JSON enriched rows   │
        └────────────────────────────┘

   ┌─────────────────────────────────────────────┐
   │ (PLANNED, not yet implemented)              │
   │ Redis on /batch-status read path:           │
   │   GET batch:{id} → fall back to DynamoDB    │
   │   SET batch:{id} {json} EX 300 on worker    │
   │   update                                    │
   └─────────────────────────────────────────────┘
```

## Why it's shaped like this

- **Read path is intentionally simpler than write path.** No queue, no DLQ — the heavy lifting on write is what lets the read stay synchronous.
- **Independent fields are served as-is from DynamoDB; dependent fields are computed in Lambda on every read.**
  - **Independent** (stored): `company_id`, `company_name`, `reporting_period`, `industry_sector`, `total_assets`, `total_liabilities`, `revenue`, `net_profit`, `cash_flow`.
  - **Dependent** (computed in Lambda): `equity`, `debt_to_asset_ratio`, `debt_to_equity_ratio`, `profit_margin`, `return_on_assets`, `cash_flow_ratio`, `risk_score`, `risk_level`.
  - We don't store the dependents — if the risk formula changes tomorrow, no backfill needed. Inputs are source of truth; outputs are a view.

## Chronological narrative

### Act 1 — Request and access-pattern selection
1. JWT auth middleware.
2. Controller inspects query params and picks one of four DynamoDB access patterns:
   - `company_id` (± `reporting_period`) → `Query` on the primary key — cheapest, single partition.
   - `industry_sector` → `Query` on the `IndustrySectorIndex` GSI — efficient but eventually consistent.
   - `reporting_period` alone → full-table `Scan` with `FilterExpression` — O(n), known wart. Would add a GSI on `reporting_period` if this query were common.
   - `industry_sector` + `reporting_period` → `Query` on the GSI with a `FilterExpression` for the period.

### Act 2 — Read from DynamoDB
- Items come back with all independent fields populated.
- GSI internals worth knowing: GSIs are eventually consistent and have their own provisioned/on-demand capacity. A base-table write propagates asynchronously to the GSI — typically milliseconds, but not synchronous. "I just wrote a row, why doesn't my GSI query see it?" is a real failure mode.

### Act 3 — Lambda invocation (compute dependents)
```js
lambda.invoke({
  FunctionName: LAMBDA_RISK_FUNCTION,
  InvocationType: "RequestResponse",     // synchronous
  Payload: JSON.stringify({ records: result.Items })
})
```
- Lambda receives the full rows and returns them enriched with the dependent fields.
- **Why Lambda and not an in-process function?** Independent deploys (change the formula without redeploying the API), independent scaling, language freedom (could move to Python/pandas for heavier models), isolation (a buggy formula can't crash the API).
- **Tradeoff:** sync invoke ties response time to Lambda cold start (~100 ms for a pure-compute Node 20 Lambda). For large result sets, async-invoke + job-id polling would mirror the upload pattern.

### Act 4 — Return enriched JSON
- Controller unwraps the Lambda response: `JSON.parse(lambdaResponse.Payload)` → `JSON.parse(body)` (double-parse because Lambda follows the API Gateway proxy response shape) → return as `data`.

## Where Redis fits (honest)

- Today: `config/redis.js` connects to a local Redis and is imported into the controller, but no `get`/`set`/`del` calls exist. Don't claim Redis is caching anything yet.
- Planned first use: cache `BATCH` status on the `/batch-status` hot path — clients poll it, so it benefits most from caching.
  - On worker update: `SET batch:{id} {json} EX 300`.
  - On status read: `GET` first; on miss, fall back to DynamoDB and repopulate.
  - Bump TTL to 1 hour once `status=Completed`.
- Planned second use: cache the Lambda risk-score result keyed by `company_id#reporting_period`. Closed-period financials don't change, so this is naturally cacheable with a long TTL, invalidated on re-upload.

---

# 3. Three tradeoffs worth memorizing

1. **Why SQS and not Kafka?** SQS is fully managed, no broker ops, scales transparently, native DLQ. Kafka gives ordered partitions, replay, higher throughput — but we don't need ordering or replay. Standard SQS + conditional writes gives durable async work with idempotency.
2. **Why conditional writes instead of a dedup table or external idempotency key?** The natural business key `(company_id, reporting_period)` is already unique by domain rules. A separate idempotency table means two writes per insert and a second source of truth to reconcile. Letting DynamoDB enforce it in one atomic op is cheaper and impossible to drift.
3. **What breaks at 100× scale?**
   - Single-worker polling → horizontally scale workers; SQS load-balances naturally.
   - Scan on `reporting_period` → add GSI on `reporting_period`.
   - DynamoDB hot partition if one `company_id` gets heavy traffic → write-sharding suffix on PK.
   - Sync Lambda on read → async + Redis cache of risk scores.

---

# 4. Things NOT to say in an interview

- Don't claim Redis is caching anything today — it isn't.
- Don't claim "exactly-once" — SQS is at-least-once. You achieve *effectively-once* via the conditional write.
- Don't claim horizontal scaling exists today — there's one of each worker. Frame it as "ready to scale because workers are stateless and SQS load-balances."
- Don't say "FIFO" — it's a standard queue.
- Don't gloss the Scan-by-`reporting_period`. Volunteer it as a known wart.
