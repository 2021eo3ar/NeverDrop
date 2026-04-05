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
-- ⚠️ Make sure Docker Desktop (or your Docker daemon) is running first!
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

## 🧪 Load Testing

Install k6:

```bash
brew install k6
```

Start the server and run the load test:

```bash
npm run dev:server
k6 run load-test.js
```

The test sends **5,000 requests/second** for 60 seconds with thresholds:

- Error rate < 1%
- p95 latency < 500ms

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
| `NEXT_PUBLIC_SERVER_URL` | API server URL | `http://localhost:3000` |

## 📄 License

MIT
