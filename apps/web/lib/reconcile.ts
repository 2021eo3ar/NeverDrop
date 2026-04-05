import {
  listOPFSChunks,
  getChunkFromOPFS,
  getChunkMeta,
  deleteChunkFromOPFS,
  incrementAttemptCount,
  type ChunkMeta,
} from "./opfs";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

// ── Configuration ────────────────────────────────────────────────────────

/** Maximum chunk age in milliseconds before we surface an error (24 hours) */
const MAX_CHUNK_AGE_MS = 24 * 60 * 60 * 1000;

/** Maximum retry attempts before a chunk is considered permanently failed */
const MAX_ATTEMPTS = 10;

/** Timeout for reconciliation network calls */
const RECONCILE_TIMEOUT_MS = 30_000;

// ── Concurrency guard ────────────────────────────────────────────────────

let isRunning = false;

// ── Types ────────────────────────────────────────────────────────────────

export interface ReconcileChunkResult {
  chunkId: string;
  status: "resynced" | "skipped" | "expired" | "max_attempts" | "error";
  attempt: number;
  error?: string;
}

export interface ReconcileResult {
  resynced: number;
  expired: number;
  failed: number;
  skipped: number;
  log: ReconcileChunkResult[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.result === null) {
        reject(new Error("FileReader returned null"));
        return;
      }
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex !== -1 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

// ── Main reconciliation function ─────────────────────────────────────────

/**
 * Reconcile locally-persisted OPFS chunks with the server.
 *
 * GUARANTEES:
 * 1. Concurrency-safe — only one reconcile() can run at a time.
 * 2. Per-chunk error isolation — one failed re-upload does NOT abort the run.
 * 3. Expired chunks (>24h) are reported but not retried further.
 * 4. Max attempt tracking — chunks exceeding MAX_ATTEMPTS are flagged.
 * 5. Detailed result log for UI display.
 *
 * This function is idempotent — safe to call multiple times.
 */
export async function reconcile(
  recordingId: string
): Promise<ReconcileResult> {
  // ── Concurrency guard ──────────────────────────────────────────────
  if (isRunning) {
    return { resynced: 0, expired: 0, failed: 0, skipped: 0, log: [] };
  }
  isRunning = true;

  const result: ReconcileResult = {
    resynced: 0,
    expired: 0,
    failed: 0,
    skipped: 0,
    log: [],
  };

  try {
    // 1. Get all local chunk IDs
    const localChunks = await listOPFSChunks();

    if (localChunks.length === 0) {
      return result;
    }

    // 2. Ask the server which are missing (with timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RECONCILE_TIMEOUT_MS
    );

    let missing: string[];
    try {
      const response = await fetch(`${SERVER_URL}/api/chunks/missing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkIds: localChunks }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const body = (await response.json()) as { missing: string[] };
      missing = body.missing;
    } catch (err) {
      clearTimeout(timeoutId);
      throw new Error(
        `Reconciliation check failed: ${
          err instanceof Error ? err.message : "unknown"
        }`
      );
    }

    // 3. Process each missing chunk individually (error-isolated)
    for (const chunkId of missing) {
      const chunkResult = await processChunk(chunkId, recordingId);
      result.log.push(chunkResult);

      switch (chunkResult.status) {
        case "resynced":
          result.resynced++;
          break;
        case "expired":
          result.expired++;
          break;
        case "max_attempts":
          result.failed++;
          break;
        case "error":
          result.failed++;
          break;
        case "skipped":
          result.skipped++;
          break;
      }
    }

    // 4. Clean up chunks that are NOT missing (already on server)
    const missingSet = new Set(missing);
    for (const chunkId of localChunks) {
      if (!missingSet.has(chunkId)) {
        await deleteChunkFromOPFS(chunkId);
        result.log.push({
          chunkId,
          status: "skipped",
          attempt: 0,
        });
        result.skipped++;
      }
    }

    return result;
  } finally {
    isRunning = false;
  }
}

/**
 * Process a single chunk for reconciliation.
 * Isolated — errors here do NOT propagate to other chunks.
 */
async function processChunk(
  chunkId: string,
  recordingId: string
): Promise<ReconcileChunkResult> {
  try {
    // Check metadata for age and attempt limits
    const meta = await getChunkMeta(chunkId);
    const attemptCount = meta?.attemptCount ?? 0;

    // Check max age — if too old, flag as expired
    if (meta && Date.now() - meta.timestamp > MAX_CHUNK_AGE_MS) {
      await deleteChunkFromOPFS(chunkId);
      return {
        chunkId,
        status: "expired",
        attempt: attemptCount,
        error: `Chunk expired after ${Math.round(
          (Date.now() - meta.timestamp) / 3600000
        )}h`,
      };
    }

    // Check max attempts — stop retrying stuck chunks
    if (attemptCount >= MAX_ATTEMPTS) {
      return {
        chunkId,
        status: "max_attempts",
        attempt: attemptCount,
        error: `Exceeded ${MAX_ATTEMPTS} upload attempts`,
      };
    }

    // Get the blob
    const blob = await getChunkFromOPFS(chunkId);
    if (!blob) {
      return {
        chunkId,
        status: "skipped",
        attempt: attemptCount,
        error: "Chunk blob not found in OPFS",
      };
    }

    // Increment attempt before upload
    await incrementAttemptCount(chunkId);

    // Convert to base64
    const data = await blobToBase64(blob);

    // Re-upload with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RECONCILE_TIMEOUT_MS
    );

    const uploadResponse = await fetch(`${SERVER_URL}/api/chunks/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunkId, recordingId, data }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (uploadResponse.ok) {
      await deleteChunkFromOPFS(chunkId);
      return {
        chunkId,
        status: "resynced",
        attempt: attemptCount + 1,
      };
    }

    // Upload failed but did not throw
    return {
      chunkId,
      status: "error",
      attempt: attemptCount + 1,
      error: `Server returned ${uploadResponse.status}`,
    };
  } catch (err) {
    // Per-chunk error isolation — this error does NOT abort the run
    return {
      chunkId,
      status: "error",
      attempt: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
