# 🎙️ NeverDrop

### Reliable browser audio recording that survives network failures.

NeverDrop is a full-stack monorepo for building a **durable browser-based audio recording pipeline**.

The core design principle is simple:

> **A recording chunk is not considered safe just because an upload was attempted. It is considered safe only after the server has acknowledged it.**

Every audio chunk is persisted locally in the browser before a network request is made. Failed uploads remain available for reconciliation instead of silently disappearing.

---

## 🧩 The Problem

Browser-based recording becomes unreliable when network connectivity is unstable.

A naive implementation looks like:

```text
Record Chunk
    ↓
Upload
    ↓
Success → Done
Failure → ❌ Chunk Lost
```

NeverDrop changes the workflow:

```text
Record Chunk
    ↓
Persist to OPFS
    ↓
Upload to S3 / MinIO
    ↓
Persist DB acknowledgement
    ↓
Delete local chunk
```

When the network fails:

```text
Record Chunk
    ↓
Persist to OPFS
    ↓
Upload ❌
    ↓
Keep local copy
    ↓
Reconcile later
    ↓
Upload again
    ↓
Verify / acknowledge
    ↓
Delete local copy
```

---

## 🏗️ Architecture

```text
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│   Record   │ ──▶ │    OPFS    │ ──▶ │  S3/MinIO  │ ──▶ │ PostgreSQL │
│   Audio    │     │  Persist   │     │   Bucket   │     │    ACK     │
└────────────┘     └─────┬──────┘     └────────────┘     └─────┬──────┘
                         │                                     │
                         │                                     │
                         ▼                                     │
                  ┌─────────────┐                              │
                  │ Reconciler  │ ◀────────────────────────────┘
                  │  Re-upload  │
                  └──────┬──────┘
                         ▲
                         │
                  browser "online"
```

### System components

| Layer           | Technology                    | Responsibility                           |
| --------------- | ----------------------------- | ---------------------------------------- |
| Web             | Next.js 14                    | Recording UI and client-side persistence |
| Browser Storage | OPFS                          | Durable local chunk storage              |
| API             | Hono.js + Node.js             | Upload and verification endpoints        |
| Object Storage  | MinIO / S3-compatible storage | Audio chunk storage                      |
| Database        | PostgreSQL + Drizzle          | Chunk acknowledgement state              |
| Monorepo        | Turborepo                     | Workspace orchestration                  |
| Load Testing    | k6                            | High-concurrency verification            |

---

## 🔄 How Reliability Works

The reliability model is based on a strict ordering:

```text
Save Locally
     ↓
Upload
     ↓
Server-side acknowledgement
     ↓
Delete Local Copy
```

The critical rule is:

> **Never delete the local chunk before the server acknowledges it.**

### 1. Persist Before Network

Every audio chunk is written to **Origin Private File System (OPFS)** before any upload request is attempted.

```text
Audio Chunk
    ↓
saveToOPFS()
    ↓
Network Upload
```

This means a temporary network failure does not destroy the only copy of the chunk.

### 2. Successful Upload

When the server confirms the chunk:

```text
Upload
   ↓
Server ACK
   ↓
Delete from OPFS
```

Only then is the local copy removed.

### 3. Failed Upload

When an upload fails:

```text
Upload ❌
   ↓
Chunk remains in OPFS
```

Nothing is silently discarded.

### 4. Reconciliation

The reconciler can run:

* when the page loads
* when the browser fires the `online` event
* manually through the UI

It checks which chunks are missing on the server and attempts to upload them again.

---

## 🔁 Idempotent Recovery

Retries must not create duplicate data.

NeverDrop uses identifiers and storage/database operations designed to make repeated uploads safe.

```text
Failed Upload
     ↓
Retry
     ↓
Server Already Has Chunk?
     │
     ├── Yes → Treat as already completed
     │
     └── No  → Store Chunk
```

The database uses conflict-safe insertion, while object storage uses deterministic object keys for repeated uploads.

This makes reconciliation safe to run multiple times.

---

## ⚡ Performance & Optimization

The project was load-tested at high concurrency and optimized around several bottlenecks.

### 1. Infrastructure Locality

The PostgreSQL database was moved from a cloud-hosted instance to a local Docker instance for the benchmark environment.

This reduced observed round-trip latency from approximately **43 seconds to under 10 ms** in the benchmark setup.

### 2. Parent-First Ingestion

The upload path was changed so the parent `recording` exists before child chunks are inserted.

This prevents foreign-key race conditions under heavy concurrency.

### 3. S3 Client Tuning

The S3 client was configured with:

* TCP keep-alive
* increased socket capacity
* up to 500 sockets

to reduce connection exhaustion during burst traffic.

### 4. Globally Unique Chunk IDs

Chunk identifiers were changed to include recording/run information:

```text
chunk-{recordingId}-{vu}-{iter}
```

This prevents primary-key collisions during concurrent load tests.

### 5. Connection Pooling

Database pool capacity and worker capacity were tuned together to avoid unnecessary contention under load.

---

## 🧪 Load Testing

The repository includes a **k6** load-test script and a separate verification script for auditing stored chunks.

### Running the test

Start the API:

```bash
npm run dev:server
```

Then run:

```bash
RECORDING_ID=ultimate-success k6 run load-test.js
```

After the test, validate the stored data:

```bash
npx tsx --env-file=apps/server/.env scripts/validate-data-loss.ts ultimate-success
```

### Benchmark Results

Validated locally with approximately 30,000 requests:

| Metric             |           Result |
| ------------------ | ---------------: |
| Total Requests     |       **30,001** |
| Success Rate       |         **100%** |
| Average Latency    |      **10.2 ms** |
| Verified Data Loss |           **0%** |
| Peak Throughput    | **~1,300 req/s** |

These results are from the repository's local benchmark environment rather than a production deployment.

---

## 🧪 Testing Failure Recovery

You can manually reproduce the main reliability scenario through Chrome DevTools.

### Offline recovery test

1. Open Chrome DevTools.
2. Go to **Network**.
3. Set the connection to **Offline**.
4. Start recording.
5. Verify that chunks are persisted locally.
6. Refresh or close the page.
7. Restore the connection.
8. Reopen the application.
9. Run reconciliation.
10. Verify that the previously unsent chunks are uploaded and removed from local storage.

This directly tests the failure mode NeverDrop is designed around.

---

## 📁 Project Structure

```text
NeverDrop/
│
├── apps/
│   ├── web/
│   │   └── Next.js 14 recording application
│   │
│   └── server/
│       └── Hono.js API server
│
├── packages/
│   ├── config/
│   │   └── Shared TypeScript configuration
│   │
│   ├── db/
│   │   └── Drizzle ORM + PostgreSQL schema
│   │
│   ├── env/
│   │   └── Type-safe environment configuration
│   │
│   └── ui/
│       └── Shared UI components
│
├── scripts/
│   ├── setup.sh
│   ├── load-test.js
│   └── validation utilities
│
├── docker-compose.yml
├── turbo.json
├── package.json
└── README.md
```

The repository is structured as a Turborepo monorepo with separate web/server applications and shared packages.

---

## 🛠️ Tech Stack

### Frontend

* Next.js 14
* React
* TypeScript
* Origin Private File System (OPFS)

### Backend

* Hono.js
* Node.js
* TypeScript

### Storage

* PostgreSQL
* Drizzle ORM
* MinIO
* S3-compatible object storage

### Tooling

* Turborepo
* Docker Compose
* k6

---

## 🚀 Getting Started

### Prerequisites

* Node.js 20+
* npm
* Docker + Docker Compose
* k6 *(optional, for load testing)*

### 1. Clone the repository

```bash
git clone https://github.com/2021eo3ar/NeverDrop.git
cd NeverDrop
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start infrastructure and configure the project

Make sure Docker is running, then execute:

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

The setup script prepares the PostgreSQL and MinIO services and configures the local environment.

### 4. Start the development environment

```bash
npm run dev
```

The repository exposes the development applications on the configured local ports, including:

```text
Web UI     → http://localhost:3001
API Server → http://localhost:3000
MinIO     → http://localhost:9001
```

---

## ⚙️ Environment Variables

### Server

Create:

```text
apps/server/.env
```

Example:

```env
DATABASE_URL=postgresql://user:password@host:port/database

BUCKET_ENDPOINT=http://localhost:9000
BUCKET_KEY=minioadmin
BUCKET_SECRET=minioadmin
BUCKET_NAME=recordings
```

### Web

Create:

```text
apps/web/.env.local
```

Example:

```env
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

The current repository documents these environment variables for local development.

---

## 📜 Available Scripts

| Command               | Purpose                                |
| --------------------- | -------------------------------------- |
| `npm run dev`         | Start the full development environment |
| `npm run build`       | Build all applications                 |
| `npm run dev:web`     | Start only the web application         |
| `npm run dev:server`  | Start only the API server              |
| `npm run check-types` | Run TypeScript type checking           |
| `npm run db:push`     | Push the Drizzle schema                |
| `npm run db:generate` | Generate migrations                    |
| `npm run db:migrate`  | Run migrations                         |
| `npm run db:studio`   | Open Drizzle Studio                    |

---

## 🔐 Reliability Invariants

The core system is designed around a few simple invariants:

### Invariant 1

**A chunk must exist locally before the network upload begins.**

### Invariant 2

**A local chunk must not be deleted until the server acknowledges it.**

### Invariant 3

**A retry must be safe even if the previous attempt partially succeeded.**

### Invariant 4

**The server must be able to identify which chunks are missing and request reconciliation.**

These invariants are more important to the system than any particular framework or storage provider.

---

## ⚠️ Limitations

NeverDrop demonstrates reliable chunk persistence and recovery, but it is still a project rather than a production recording platform.

Current limitations include:

* The benchmark results are from a controlled local environment.
* S3-compatible storage is represented locally through MinIO.
* The browser's local storage lifecycle and quota constraints still apply.
* The system depends on the browser supporting OPFS.
* Production authentication, authorization, observability, and operational monitoring would require additional work.

---

## 🔮 Possible Improvements

* [ ] Add production authentication and authorization
* [ ] Add end-to-end automated reliability tests
* [ ] Add richer upload/reconciliation observability
* [ ] Add configurable retry policies
* [ ] Add production object-storage deployment
* [ ] Add recording-session recovery across devices
* [ ] Add monitoring and alerting
* [ ] Add CI/CD for the monorepo
* [ ] Expand benchmark coverage across network conditions

---

## 📄 License

MIT

---

<p align="center">
  <b>NeverDrop</b> — treat every recording chunk as durable work until it is acknowledged.
</p>
