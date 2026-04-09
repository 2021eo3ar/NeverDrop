# 🎙️ Reliable Recording Chunking Pipeline

A full-stack monorepo implementing a **reliable audio recording pipeline** that guarantees no chunk is ever lost — even during network failures.

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Record  │───▶│   OPFS   │───▶│  Bucket  │───▶│  DB Ack  │
│  (audio) │    │ (persist)│    │ (S3/Min) │    │  (PG)    │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │                │                                │
     │                ▼                                │
     │         ┌─────────────┐                         │
     │         │ Reconciler  │◀────────────────────────┘
     │         │ (re-upload) │
     │         └─────────────┘
     │                ▲
     └────────────────┘
          (on "online" event)
```

## ✨ Architecture

| Layer        | Technology               | Purpose                        |
| ------------ | ------------------------ | ------------------------------ |
| **Frontend** | Next.js 14 (App Router)  | Recording UI, OPFS persistence |
| **Backend**  | Hono.js + Node.js        | Chunk upload/verify API        |
| **Storage**  | MinIO (S3-compatible)    | Audio chunk binary storage     |
| **Database** | PostgreSQL + Drizzle ORM | Chunk acknowledgement tracking |
| **Build**    | Turborepo                | Monorepo orchestration         |

## 📋 Prerequisites

- **Node.js** 20+ and npm
- **Docker** & Docker Compose
- **k6** (optional, for load testing)

## 🚀 Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd recording-assignment

# 2. Install dependencies
npm install

# 3. Run setup (starts Postgres + MinIO, creates env files, pushes schema)
# ⚠️ Make sure Docker Desktop (or your Docker daemon) is running first!
chmod +x scripts/setup.sh
./scripts/setup.sh

### 3.5 (Alternative) Manual Environment Setup
If the setup script fails or you are using a remote database, manually create the `.env` files:

1. **Server (`apps/server/.env`)**
   Create this file and add your `DATABASE_URL` and `BUCKET` variables. Example:
   ```env
   DATABASE_URL=postgresql://user:password@host:port/database
   BUCKET_ENDPOINT=http://localhost:9000
   BUCKET_KEY=minioadmin
   BUCKET_SECRET=minioadmin
   BUCKET_NAME=recordings
   ```

2. **Web (`apps/web/.env.local`)**
   Create this file to define the API connection:
   ```env
   NEXT_PUBLIC_SERVER_URL=http://localhost:3000
   ```
### 3.5 (Alternative) Manual Environment Setup
If the setup script fails or you are using a remote database, manually create the `.env` files:

1. **Server (`apps/server/.env`)**
   Create this file and add your `DATABASE_URL` and `BUCKET` variables. Example:
   ```env
   DATABASE_URL=postgresql://user:password@host:port/database
   BUCKET_ENDPOINT=http://localhost:9000
   BUCKET_KEY=minioadmin
   BUCKET_SECRET=minioadmin
   BUCKET_NAME=recordings
   ```

2. **Web (`apps/web/.env.local`)**
   Create this file to define the API connection:
   ```env
   NEXT_PUBLIC_SERVER_URL=http://localhost:3000
   ```

# 4. Start development
npm run dev
```

- **Web UI**: http://localhost:3001
- **API Server**: http://localhost:3000
- **MinIO Console**: http://localhost:9001 (minioadmin / minioadmin)

## 📦 Project Structure

```
recording-assignment/
├── apps/
│   ├── web/          # Next.js 14 frontend
│   └── server/       # Hono.js API server
├── packages/
│   ├── config/       # Shared TypeScript configs
│   ├── db/           # Drizzle ORM + PostgreSQL schema
│   ├── env/          # Type-safe environment variables
│   └── ui/           # Shared UI components
├── docker-compose.yml
├── load-test.js      # k6 load test
└── turbo.json
```

## 🛠️ Available Scripts

| Script                | Description                        |
| --------------------- | ---------------------------------- |
| `npm run dev`         | Start all apps in development mode |
| `npm run build`       | Build all apps for production      |
| `npm run dev:web`     | Start only the web app             |
| `npm run dev:server`  | Start only the API server          |
| `npm run check-types` | Run TypeScript type checking       |
| `npm run db:push`     | Push Drizzle schema to database    |
| `npm run db:generate` | Generate Drizzle migrations        |
| `npm run db:migrate`  | Run Drizzle migrations             |
| `npm run db:studio`   | Open Drizzle Studio                |

## 🔄 How OPFS Recovery Works

The core reliability guarantee is built on the **Origin Private File System (OPFS)**:

1. **Before any network call**, each audio chunk is saved to OPFS (browser-native persistent storage)
2. On successful upload, the chunk is removed from OPFS
3. On failure, the chunk **remains in OPFS** for later reconciliation
4. The **Reconciler** runs:
   - Automatically on page load
   - When the browser comes back online (`online` event)
   - Manually via the "Run Reconciliation" button
5. The Reconciler asks the server which chunks are missing, then re-uploads them
6. This process is **idempotent** — `onConflictDoNothing()` in the DB and `PutObject` in S3 make repeat uploads safe

```
Upload Flow:
  chunk → saveToOPFS() → fetch(/upload) → deleteFromOPFS()
                                ↓ (on failure)
                          chunk stays in OPFS
                                ↓
  Reconciler → listOPFS() → fetch(/missing) → re-upload → deleteFromOPFS()
```

## 🚀 Performance & Optimizations

To achieve zero data loss at high throughput (30,000+ requests), the following optimizations were implemented:

1.  **Infrastructure Locality**: Migrated from cloud-based database (Neon) to a local Docker PostgreSQL instance. This reduced round-trip latency from **43,000ms to <10ms**.
2.  **Parent-First Ingestion**: Refactored the upload handler to sequentially ensure the parent `recording` exists before inserting chunks. This prevents Foreign Key race conditions under extreme concurrency.
3.  **S3 Client Tuning**: Configured the AWS SDK with `TCP KeepAlive` and increased `maxSockets` to 500 to prevent connection exhaustion during bursts.
4.  **Unique Key Strategy**: Updated chunk IDs to be globally unique per run (`chunk-${recordingId}-${vu}-${iter}`) to prevent silent primary key collisions in the database.
5.  **Connection Pooling**: Matched the Database pool size (100) and Hono worker capacity to prevent thread starvation.

## 🧪 Load Testing

### 1. Requirements
- **k6**: `brew install k6`
- **Docker**: For local Postgres and MinIO.

### 2. Running the Test
Start the server and execute the k6 script with a custom `RECORDING_ID`:

```bash
# Terminal 1: Start Server
npm run dev:server

# Terminal 2: Run Load Test
RECORDING_ID=ultimate-success k6 run load-test.js
```

### 3. Verification & Audit
After the test, run the data loss validation script to ensure every DB acknowledgement has a corresponding S3 object:

```bash
# Run the audit for a specific recording
npx tsx --env-file=apps/server/.env scripts/validate-data-loss.ts ultimate-success
```

### 4. Benchmark Results (The "Ultimate Success")
Validated on a local machine with 30,000 requests:

| Metric | Result |
| :--- | :--- |
| **Total Requests** | 30,001 |
| **Success Rate** | 100% |
| **Avg Latency** | **10.2ms** |
| **Data Loss** | **0% (Verified)** |
| **Peak Throughput** | ~1,300 req/s |

## 🔐 Environment Variables

### Server (`apps/server/.env`)

| Variable          | Description                  | Default                                                   |
| ----------------- | ---------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`    | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/recording` |
| `BUCKET_ENDPOINT` | S3/MinIO endpoint            | `http://localhost:9000`                                   |
| `BUCKET_KEY`      | S3 access key                | `minioadmin`                                              |
| `BUCKET_SECRET`   | S3 secret key                | `minioadmin`                                              |
| `BUCKET_NAME`     | S3 bucket name               | `recordings`                                              |

### Web (`apps/web/.env.local`)

| Variable                 | Description    | Default                 |
| ------------------------ | -------------- | ----------------------- |
### 5. Manual Validation (OPFS Recovery)
To test the reliability of the system under unstable network conditions:

1.  **Go Offline**: Open Chrome DevTools -> Network -> Select **Offline**.
2.  **Record**: Click "Start Recording" in the Web UI. Notice the status: `saved to OPFS`.
3.  **Persist**: Close the browser tab or refresh the page.
4.  **Go Online**: In DevTools, switch back to **No throttling**.
5.  **Reconcile**: Open the app again. Click **"Run Reconciliation"**.
6.  **Verify**: The chunks recorded while offline will be automatically uploaded to the server and cleared from local storage.

## 📄 License

MIT
