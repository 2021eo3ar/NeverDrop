import { saveChunkToOPFS, deleteChunkFromOPFS, incrementAttemptCount } from "./opfs";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

// ── Retry configuration ──────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // exponential backoff
const UPLOAD_TIMEOUT_MS = 30_000; // 30 second timeout per attempt

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Converts a Blob to a base64 string.
 * Wraps FileReader in a Promise with explicit error handling.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (blob.size === 0) {
      reject(new Error("Cannot convert empty blob to base64"));
      return;
    }

    const reader = new FileReader();

    reader.onloadend = () => {
      if (reader.result === null) {
        reject(new Error("FileReader returned null result"));
        return;
      }
      const result = reader.result as string;
      // Remove the data URL prefix (e.g. "data:audio/webm;base64,")
      const commaIndex = result.indexOf(",");
      const base64 = commaIndex !== -1 ? result.slice(commaIndex + 1) : result;
      if (!base64) {
        reject(new Error("Base64 conversion produced empty string"));
        return;
      }
      resolve(base64);
    };

    reader.onerror = () => {
      reject(new Error(`FileReader error: ${reader.error?.message ?? "unknown"}`));
    };

    reader.readAsDataURL(blob);
  });
}

/**
 * Determine if an error/response is retryable.
 * Retry on: network errors, 5xx server errors.
 * Never retry on: 4xx client errors (bad request, validation failure).
 */
function isRetryableError(error: unknown, status?: number): boolean {
  // Network errors (fetch throws TypeError on network failure)
  if (error instanceof TypeError) return true;
  // AbortError from timeout — retryable
  if (error instanceof DOMException && error.name === "AbortError") return true;
  // 5xx server errors
  if (status !== undefined && status >= 500) return true;
  // 4xx — never retry
  if (status !== undefined && status >= 400 && status < 500) return false;
  // Unknown errors — retry to be safe
  return true;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main upload function ─────────────────────────────────────────────────

/**
 * Upload a single chunk to the server with retry logic.
 *
 * CRITICAL GUARANTEE: The chunk is saved to OPFS BEFORE any network call.
 * This ensures that even if all retries fail, the chunk is persisted
 * locally and can be re-uploaded by the reconciler.
 *
 * Retry policy:
 *  - 3 retries with exponential backoff (1s → 2s → 4s)
 *  - Only retry on network errors or 5xx responses
 *  - Never retry on 4xx (client errors — the request is bad)
 *  - 30 second timeout per attempt via AbortController
 */
export async function uploadChunk(
  chunkId: string,
  recordingId: string,
  blob: Blob
): Promise<void> {
  // 1. MUST persist to OPFS before any network call — this is the
  //    core reliability guarantee of the entire pipeline
  await saveChunkToOPFS(chunkId, blob, {
    recordingId,
    timestamp: Date.now(),
    attemptCount: 0,
  });

  // 2. Convert blob to base64 (can throw — chunk is safely in OPFS)
  let data: string;
  try {
    data = await blobToBase64(blob);
  } catch (err) {
    // base64 conversion failed — chunk stays in OPFS for reconciler
    throw new Error(
      `Base64 encoding failed for chunk ${chunkId}: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }

  // 3. Attempt upload with retries
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Wait before retry (skip delay on first attempt)
    if (attempt > 0) {
      await incrementAttemptCount(chunkId);
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 4000);
    }

    // Create per-attempt AbortController with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(`${SERVER_URL}/api/chunks/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkId, recordingId, data }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Upload succeeded — remove from OPFS
        await deleteChunkFromOPFS(chunkId);
        return;
      }

      // Non-OK response
      const errorBody = await response.json().catch(() => ({}));
      const errorMsg =
        (errorBody as { error?: string }).error ??
        `Upload failed with status ${response.status}`;
      lastError = new Error(errorMsg);

      // Don't retry on 4xx
      if (!isRetryableError(null, response.status)) {
        break;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      lastError =
        err instanceof Error ? err : new Error("Unknown upload error");

      if (!isRetryableError(err)) {
        break;
      }
    }
  }

  // All retries exhausted — chunk stays in OPFS for the reconciler
  throw lastError ?? new Error(`Upload failed for chunk ${chunkId}`);
}
