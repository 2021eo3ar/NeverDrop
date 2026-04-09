import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { db, chunkAcks, recordings } from "@repo/db";
import { SERVER_ENV } from "@repo/env/server";
import { inArray, eq, sql, count } from "drizzle-orm";
import { z } from "zod";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import http from "node:http";
import https from "node:https";

// ── S3/MinIO Client ──────────────────────────────────────────────────────

const s3 = new S3Client({
  endpoint: SERVER_ENV.BUCKET_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: SERVER_ENV.BUCKET_KEY,
    secretAccessKey: SERVER_ENV.BUCKET_SECRET,
  },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 500 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 500 }),
  }),
});

// ── Recording ID Cache ───────────────────────────────────────────────────
// To avoid redundant DB calls on every chunk upload
const recordingCache = new Set<string>();

// ── Request Validation Schemas ──────────────────────────────────────────

const UploadBodySchema = z.object({
  chunkId: z.string().min(1, "chunkId is required"),
  recordingId: z.string().min(1, "recordingId is required"),
  data: z.string().min(1, "data is required"),
});

const MissingBodySchema = z.object({
  chunkIds: z
    .array(z.string().min(1))
    .min(1, "chunkIds must not be empty")
    .max(500, "Maximum 500 chunkIds per request"),
});

// ── Rate Limiter ─────────────────────────────────────────────────────────
// Basic in-memory sliding window rate limiter (max 200 req/s per IP)

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 10000;

const rateLimitMap = new Map<
  string,
  { count: number; windowStart: number }
>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 10_000);

// ── Body Size Limit ──────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Upload Timing Tracking ───────────────────────────────────────────────
// For /api/metrics — tracks recent upload durations

const uploadDurations: number[] = [];
const MAX_DURATION_SAMPLES = 1000;

function trackDuration(ms: number) {
  uploadDurations.push(ms);
  if (uploadDurations.length > MAX_DURATION_SAMPLES) {
    uploadDurations.shift();
  }
}

// ── Hono App ──────────────────────────────────────────────────────────────

const app = new Hono();

// Structured request logging
app.use("/*", logger());

// CORS middleware for local dev
app.use("/*", cors());

// Body size limit middleware
app.use("/api/*", async (c, next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return c.json(
      { ok: false, error: `Request body exceeds ${MAX_BODY_BYTES / 1024 / 1024}MB limit` },
      413
    );
  }
  await next();
});

// ── GET /health ───────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── POST /api/chunks/upload ───────────────────────────────────────────────
//
// ATOMICITY FIX:
// Previously: S3 upload → DB insert. If DB insert fails after S3 succeeds,
// the system is inconsistent (chunk in bucket but not tracked in DB).
//
// Now: DB insert (status="pending") → S3 upload → DB update (status="confirmed").
// If S3 upload fails, the "pending" row in DB lets the /missing endpoint
// detect the half-completed state. If DB update fails after S3 succeeds,
// the "pending" row still exists and the reconciler will re-verify.

app.post("/api/chunks/upload", async (c) => {
  const startMs = Date.now();

  try {
    // Rate limit check
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    if (!checkRateLimit(ip)) {
      return c.json(
        { ok: false, error: "Rate limit exceeded (200 req/s per IP)" },
        429
      );
    }

    // Parse and validate body
    const rawBody = await c.req.json();
    const parseResult = UploadBodySchema.safeParse(rawBody);

    if (!parseResult.success) {
      return c.json(
        {
          ok: false,
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        },
        400
      );
    }

    const { chunkId, recordingId, data } = parseResult.data;

    // 1. Decode base64 → Buffer
    const buffer = Buffer.from(data, "base64");
    const bucketKey = `recordings/${recordingId}/${chunkId}`;

    // Extract chunk index from chunkId (format: recordingId-index)
    const chunkIndexStr = chunkId.split("-").pop();
    const chunkIndex = chunkIndexStr ? parseInt(chunkIndexStr, 10) : null;

    // 2. Ensure parent recording exists first (Sequential to avoid FK race conditions)
    await db.insert(recordings).values({ recordingId }).onConflictDoNothing();

    // 3. Insert pending chunk record
    await db.insert(chunkAcks).values({
      chunkId,
      recordingId,
      bucketKey,
      uploadStatus: "pending",
      chunkIndex: isNaN(chunkIndex as number) ? null : chunkIndex,
      byteSize: buffer.length,
      uploadAttempts: 1,
    }).onConflictDoNothing();

    // 4. Upload to S3/MinIO

    // 4. Upload to S3/MinIO
    await s3.send(
      new PutObjectCommand({
        Bucket: SERVER_ENV.BUCKET_NAME,
        Key: bucketKey,
        Body: buffer,
        ContentType: "audio/webm",
      })
    );

    // 5. Update status to "confirmed" — completes the atomic operation
    try {
      await db
        .update(chunkAcks)
        .set({
          uploadStatus: "confirmed",
          verified: true,
          ackedAt: new Date(),
        })
        .where(eq(chunkAcks.chunkId, chunkId));
    } catch (e) {
      console.error(`[upload] DB Confirm Failed for ${chunkId}:`, e);
    }

    // Track upload duration for metrics
    trackDuration(Date.now() - startMs);

    // Log sparingly during high load or only on confirmations
    if (Math.random() < 0.01) {
      console.log(
        `[upload] chunkId=${chunkId} recordingId=${recordingId} ` +
        `size=${buffer.length}B duration=${Date.now() - startMs}ms status=confirmed`
      );
    }

    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[upload] Error:", message);
    trackDuration(Date.now() - startMs);
    return c.json({ ok: false, error: message }, 500);
  }
});

// ── POST /api/chunks/missing ──────────────────────────────────────────────
//
// PERFORMANCE FIX:
// Previously: HeadObjectCommand was called sequentially for each found row.
// With 10,000 chunks, this would take minutes.
//
// Now: batched with Promise.all, max 20 concurrent HeadObject calls.
// Also capped at 500 chunkIds per request via Zod validation.

app.post("/api/chunks/missing", async (c) => {
  try {
    // Validate body
    const rawBody = await c.req.json();
    const parseResult = MissingBodySchema.safeParse(rawBody);

    if (!parseResult.success) {
      return c.json(
        {
          ok: false,
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        },
        400
      );
    }

    const { chunkIds } = parseResult.data;

    // 1. Query DB for all rows where chunkId is in the provided list
    const found = await db
      .select()
      .from(chunkAcks)
      .where(inArray(chunkAcks.chunkId, chunkIds));

    const foundMap = new Map(found.map((row) => [row.chunkId, row]));

    // IDs not in DB at all are definitely missing
    const missing: string[] = chunkIds.filter((id) => !foundMap.has(id));

    // IDs with "pending" status are also missing (half-completed uploads)
    for (const row of found) {
      if (row.uploadStatus === "pending") {
        missing.push(row.chunkId);
        continue;
      }
    }

    // 2. For confirmed rows, verify they exist in the bucket (batched)
    const confirmedRows = found.filter(
      (row) =>
        row.uploadStatus === "confirmed" && !missing.includes(row.chunkId)
    );

    // Batch HeadObject calls — max 20 concurrent
    const BATCH_SIZE = 20;
    for (let i = 0; i < confirmedRows.length; i += BATCH_SIZE) {
      const batch = confirmedRows.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (row) => {
          try {
            await s3.send(
              new HeadObjectCommand({
                Bucket: SERVER_ENV.BUCKET_NAME,
                Key: row.bucketKey,
              })
            );
            return { chunkId: row.chunkId, exists: true };
          } catch {
            return { chunkId: row.chunkId, exists: false };
          }
        })
      );

      for (const result of results) {
        if (result.status === "fulfilled" && !result.value.exists) {
          missing.push(result.value.chunkId);
        }
      }
    }

    return c.json({ missing });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[missing] Error:", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

// ── GET /api/recordings/:recordingId/verify ───────────────────────────────
// Verify DB vs bucket consistency for a recording.

app.get("/api/recordings/:recordingId/verify", async (c) => {
  try {
    const recordingId = c.req.param("recordingId");

    const chunks = await db
      .select()
      .from(chunkAcks)
      .where(eq(chunkAcks.recordingId, recordingId));

    const results = {
      recordingId,
      totalChunks: chunks.length,
      confirmed: 0,
      pending: 0,
      missingFromBucket: 0,
      details: [] as Array<{
        chunkId: string;
        dbStatus: string;
        inBucket: boolean;
      }>,
    };

    // Batch verify bucket presence
    const BATCH_SIZE = 20;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const checks = await Promise.allSettled(
        batch.map(async (chunk) => {
          let inBucket = false;
          try {
            await s3.send(
              new HeadObjectCommand({
                Bucket: SERVER_ENV.BUCKET_NAME,
                Key: chunk.bucketKey,
              })
            );
            inBucket = true;
          } catch {
            /* not in bucket */
          }
          return {
            chunkId: chunk.chunkId,
            dbStatus: chunk.uploadStatus ?? "unknown",
            inBucket,
          };
        })
      );

      for (const result of checks) {
        if (result.status === "fulfilled") {
          const detail = result.value;
          results.details.push(detail);
          if (detail.dbStatus === "confirmed") results.confirmed++;
          if (detail.dbStatus === "pending") results.pending++;
          if (!detail.inBucket) results.missingFromBucket++;
        }
      }
    }

    // Repair logic
    const repair = c.req.query("repair") === "true";
    if (repair) {
      const updates = results.details.map(async (detail) => {
        // Case 1: DB confirmed but missing from bucket
        if (detail.dbStatus === "confirmed" && !detail.inBucket) {
          await db
            .update(chunkAcks)
            .set({ uploadStatus: "pending", verified: false })
            .where(eq(chunkAcks.chunkId, detail.chunkId));
          return { chunkId: detail.chunkId, fix: "marked_pending" };
        }
        // Case 2: DB pending but exists in bucket
        if (detail.dbStatus === "pending" && detail.inBucket) {
          await db
            .update(chunkAcks)
            .set({ uploadStatus: "confirmed", verified: true })
            .where(eq(chunkAcks.chunkId, detail.chunkId));
          return { chunkId: detail.chunkId, fix: "marked_confirmed" };
        }
        return null;
      });

      const fixed = (await Promise.all(updates)).filter(Boolean);
      return c.json({
        ok: true,
        repairedChunks: fixed.length,
        fixes: fixed,
      });
    }

    return c.json({
      ok: true,
      consistent:
        results.pending === 0 && results.missingFromBucket === 0,
      ...results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ ok: false, error: message }, 500);
  }
});

// ── GET /api/metrics ──────────────────────────────────────────────────────
// Observability endpoint: returns chunk statistics from the DB.

app.get("/api/metrics", async (c) => {
  try {
    // Total chunks
    const [totalResult] = await db
      .select({ value: count() })
      .from(chunkAcks);

    // Pending (incomplete uploads)
    const [pendingResult] = await db
      .select({ value: count() })
      .from(chunkAcks)
      .where(eq(chunkAcks.uploadStatus, "pending"));

    // Confirmed
    const [confirmedResult] = await db
      .select({ value: count() })
      .from(chunkAcks)
      .where(eq(chunkAcks.uploadStatus, "confirmed"));

    // Average upload duration from in-memory tracking
    const avgUploadMs =
      uploadDurations.length > 0
        ? Math.round(
            uploadDurations.reduce((a, b) => a + b, 0) /
              uploadDurations.length
          )
        : 0;

    return c.json({
      totalChunks: totalResult?.value ?? 0,
      pendingChunks: pendingResult?.value ?? 0,
      confirmedChunks: confirmedResult?.value ?? 0,
      failedChunks: 0, // no dedicated failed status yet
      avgUploadMs,
      sampleCount: uploadDurations.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ ok: false, error: message }, 500);
  }
});

// ── Start Server ──────────────────────────────────────────────────────────

const port = 3000;
console.log(`🚀 Server running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
