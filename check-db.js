import { db, chunkAcks } from "./packages/db/src/index.js";
import { eq, count } from "drizzle-orm";

async function verify() {
  const recordingId = "recording-test-123";
  const result = await db
    .select({ 
      total: count(),
      confirmed: count(chunkAcks.verified),
    })
    .from(chunkAcks)
    .where(eq(chunkAcks.recordingId, recordingId));

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

verify().catch(console.error);
