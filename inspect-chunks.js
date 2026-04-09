import { db, chunkAcks } from "./packages/db/src/index.ts";
import { eq, desc } from "drizzle-orm";

async function inspect() {
  const result = await db
    .select()
    .from(chunkAcks)
    .orderBy(desc(chunkAcks.ackedAt))
    .limit(50);

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

inspect().catch(console.error);
