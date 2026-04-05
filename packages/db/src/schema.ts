import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";

// ── Recordings table ─────────────────────────────────────────────────────
// Parent table for grouping chunks into recordings.

export const recordings = pgTable("recordings", {
  recordingId: text("recording_id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow(),
  totalChunks: integer("total_chunks").default(0),
  status: text("status").default("active"), // active | completed | failed
});

export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;

// ── Chunk acknowledgements table ─────────────────────────────────────────
// Tracks individual chunk uploads with lifecycle status.

export const chunkAcks = pgTable(
  "chunk_acks",
  {
    chunkId: text("chunk_id").primaryKey(),
    recordingId: text("recording_id").notNull(),
    bucketKey: text("bucket_key").notNull(),
    ackedAt: timestamp("acked_at").defaultNow(),
    verified: boolean("verified").default(false),
    /** Ordered index within the recording for reassembly */
    chunkIndex: integer("chunk_index"),
    /** Number of upload attempts by the client */
    uploadAttempts: integer("upload_attempts").default(0),
    /** Size of the chunk in bytes — used to verify integrity */
    byteSize: integer("byte_size"),
    /**
     * Upload lifecycle status:
     *  - "pending"   → DB row written, but S3 upload not yet confirmed
     *  - "confirmed" → S3 upload succeeded and verified
     */
    uploadStatus: text("upload_status").default("confirmed"),
  },
  (table) => [
    // Index on recordingId for fast reconciliation queries
    index("idx_chunk_acks_recording_id").on(table.recordingId),
    // Index on uploadStatus for finding pending/failed uploads
    index("idx_chunk_acks_upload_status").on(table.uploadStatus),
  ]
);

export type ChunkAck = typeof chunkAcks.$inferSelect;
export type NewChunkAck = typeof chunkAcks.$inferInsert;
