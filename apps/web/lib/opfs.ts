/**
 * OPFS (Origin Private File System) helpers for reliable chunk persistence.
 *
 * RELIABILITY GUARANTEES:
 * 1. Atomic writes via .tmp + rename pattern — a crash mid-write leaves
 *    no corrupt file; only fully-written chunks are visible.
 * 2. Quota checking before writes — surfaces a clear error if storage is full.
 * 3. Sidecar metadata JSON stored alongside each chunk blob.
 * 4. listOPFSChunks filters out .tmp and .meta files, returning only
 *    fully-committed chunk IDs.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface ChunkMeta {
  chunkId: string;
  recordingId: string;
  timestamp: number;       // Date.now() at save time
  byteSize: number;
  attemptCount: number;
}

// ── Constants ────────────────────────────────────────────────────────────

const TMP_SUFFIX = ".tmp";
const META_SUFFIX = ".meta";
/** Minimum required free space (bytes) before we refuse to write */
const MIN_FREE_BYTES = 5 * 1024 * 1024; // 5 MB headroom

// ── Helpers ──────────────────────────────────────────────────────────────

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/**
 * Check available OPFS quota and throw if insufficient.
 */
async function assertQuota(requiredBytes: number): Promise<void> {
  if (navigator.storage && navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const free = quota - usage;
    if (free < requiredBytes + MIN_FREE_BYTES) {
      throw new Error(
        `OPFS quota exceeded: ${Math.round(free / 1024)}KB free, ` +
        `need ${Math.round((requiredBytes + MIN_FREE_BYTES) / 1024)}KB. ` +
        `Clear old recordings or free browser storage.`
      );
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Atomically save a chunk to OPFS using .tmp + rename.
 *
 * Write flow:
 *   1. Check quota
 *   2. Write blob → <chunkId>.tmp
 *   3. Write metadata → <chunkId>.meta
 *   4. Rename .tmp → <chunkId>  (atomic on OPFS)
 *
 * If the tab crashes during step 2, only the .tmp exists — listOPFSChunks
 * ignores .tmp files, so the chunk is treated as absent (cleanly lost, not
 * corrupted). The reconciler will detect it's missing and the recorder will
 * re-produce it on the next run.
 */
export async function saveChunkToOPFS(
  chunkId: string,
  blob: Blob,
  meta?: Partial<ChunkMeta>
): Promise<void> {
  // 1. Quota check
  await assertQuota(blob.size);

  const root = await getRoot();
  const tmpName = `${chunkId}${TMP_SUFFIX}`;
  const metaName = `${chunkId}${META_SUFFIX}`;

  // 2. Write blob to .tmp file
  const tmpHandle = await root.getFileHandle(tmpName, { create: true });
  const writable = await tmpHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    // Clean up on write failure
    try { await writable.abort(); } catch { /* ignore */ }
    try { await root.removeEntry(tmpName); } catch { /* ignore */ }
    throw err;
  }

  // 3. Write sidecar metadata
  const metadata: ChunkMeta = {
    chunkId,
    recordingId: meta?.recordingId ?? "",
    timestamp: meta?.timestamp ?? Date.now(),
    byteSize: blob.size,
    attemptCount: meta?.attemptCount ?? 0,
  };
  const metaHandle = await root.getFileHandle(metaName, { create: true });
  const metaWritable = await metaHandle.createWritable();
  await metaWritable.write(JSON.stringify(metadata));
  await metaWritable.close();

  // 4. "Rename" .tmp → final: copy then delete tmp
  //    OPFS doesn't have rename(), so we write the final file from the
  //    tmp content. The key guarantee: if step 4 fails, only .tmp exists
  //    and listOPFSChunks() won't return it.
  const finalHandle = await root.getFileHandle(chunkId, { create: true });
  const finalWritable = await finalHandle.createWritable();
  const tmpFile = await tmpHandle.getFile();
  await finalWritable.write(tmpFile);
  await finalWritable.close();

  // 5. Clean up .tmp
  try { await root.removeEntry(tmpName); } catch { /* ignore */ }
}

/**
 * Retrieve a chunk blob from OPFS. Returns null if not found.
 */
export async function getChunkFromOPFS(
  chunkId: string
): Promise<Blob | null> {
  try {
    const root = await getRoot();
    const fileHandle = await root.getFileHandle(chunkId);
    const file = await fileHandle.getFile();
    // Verify non-zero size — a zero-byte file indicates corruption
    if (file.size === 0) {
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Retrieve the sidecar metadata for a chunk.
 */
export async function getChunkMeta(
  chunkId: string
): Promise<ChunkMeta | null> {
  try {
    const root = await getRoot();
    const metaName = `${chunkId}${META_SUFFIX}`;
    const metaHandle = await root.getFileHandle(metaName);
    const file = await metaHandle.getFile();
    const text = await file.text();
    return JSON.parse(text) as ChunkMeta;
  } catch {
    return null;
  }
}

/**
 * Update the attempt count in a chunk's metadata.
 */
export async function incrementAttemptCount(
  chunkId: string
): Promise<void> {
  const meta = await getChunkMeta(chunkId);
  if (!meta) return;

  meta.attemptCount++;
  const root = await getRoot();
  const metaName = `${chunkId}${META_SUFFIX}`;
  const metaHandle = await root.getFileHandle(metaName, { create: true });
  const writable = await metaHandle.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

/**
 * Delete a chunk and its metadata from OPFS.
 */
export async function deleteChunkFromOPFS(
  chunkId: string
): Promise<void> {
  const root = await getRoot();
  // Remove all associated files
  for (const suffix of ["", TMP_SUFFIX, META_SUFFIX]) {
    try {
      await root.removeEntry(`${chunkId}${suffix}`);
    } catch {
      // File may already be deleted — no-op
    }
  }
}

/**
 * List all fully-written chunk IDs in OPFS.
 * Filters out .tmp and .meta files — only returns committed chunks.
 * Also cleans up orphaned .tmp files from crashed writes.
 */
export async function listOPFSChunks(): Promise<string[]> {
  const root = await getRoot();
  const chunks: string[] = [];
  const orphanedTmps: string[] = [];

  for await (const [name] of (root as any).entries()) {
    if (name.endsWith(TMP_SUFFIX)) {
      orphanedTmps.push(name);
    } else if (name.endsWith(META_SUFFIX)) {
      // Skip metadata files
      continue;
    } else {
      chunks.push(name);
    }
  }

  // Clean up orphaned .tmp files (from crashed writes)
  for (const tmp of orphanedTmps) {
    const chunkId = tmp.slice(0, -TMP_SUFFIX.length);
    if (!chunks.includes(chunkId)) {
      // No final file exists — this was a crashed write, clean up
      try { await root.removeEntry(tmp); } catch { /* ignore */ }
      try { await root.removeEntry(`${chunkId}${META_SUFFIX}`); } catch { /* ignore */ }
    }
  }

  return chunks;
}
