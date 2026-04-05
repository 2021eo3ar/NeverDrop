#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔧 Setting up Recording Pipeline..."

# 1. Copy server .env.example → .env if not exists
if [ ! -f "$ROOT_DIR/apps/server/.env" ]; then
  cp "$ROOT_DIR/apps/server/.env.example" "$ROOT_DIR/apps/server/.env"
  echo "✅ Created apps/server/.env from .env.example"
else
  echo "⏭️  apps/server/.env already exists, skipping"
fi

# 2. Create web .env.local if not exists
if [ ! -f "$ROOT_DIR/apps/web/.env.local" ]; then
  echo "NEXT_PUBLIC_SERVER_URL=http://localhost:3000" > "$ROOT_DIR/apps/web/.env.local"
  echo "✅ Created apps/web/.env.local"
else
  echo "⏭️  apps/web/.env.local already exists, skipping"
fi

# 3. Start Docker services
echo "🐳 Starting Docker services..."
cd "$ROOT_DIR"
docker-compose up -d

# 4. Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 3

# 5. Push database schema
echo "📦 Pushing database schema..."
npm run db:push

echo ""
echo "✅ Setup complete. Run: npm run dev"
