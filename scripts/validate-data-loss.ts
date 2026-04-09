import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { db, chunkAcks } from "../packages/db/src/index.ts";
import { eq } from "drizzle-orm";
import { SERVER_ENV } from "../packages/env/src/server.ts";

const s3 = new S3Client({
  endpoint: SERVER_ENV.BUCKET_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: SERVER_ENV.BUCKET_KEY,
    secretAccessKey: SERVER_ENV.BUCKET_SECRET,
  },
  forcePathStyle: true,
});

async function validate(recordingId: string) {
  console.log(`\n🔍 Validating data loss for recording: ${recordingId}`);

  // 1. Get DB chunks
  const dbChunks = await db
    .select()
    .from(chunkAcks)
    .where(eq(chunkAcks.recordingId, recordingId));

  const dbConfirmed = dbChunks.filter(c => c.uploadStatus === "confirmed");
  const dbPending = dbChunks.filter(c => c.uploadStatus === "pending");

  console.log(`- DB: ${dbConfirmed.length} confirmed, ${dbPending.length} pending`);

  // 2. Get Bucket objects (with pagination)
  console.log(`- Fetching objects from bucket...`);
  const bucketKeys = new Set<string>();
  let continuationToken: string | undefined = undefined;

  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: SERVER_ENV.BUCKET_NAME,
      Prefix: `recordings/${recordingId}/`,
      ContinuationToken: continuationToken,
    }));

    if (listRes.Contents) {
      for (const obj of listRes.Contents) {
        if (obj.Key) bucketKeys.add(obj.Key);
      }
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  console.log(`- Bucket: ${bucketKeys.size} objects found`);

  // 3. Comparison
  let inconsistencies = 0;

  // DB confirmed but missing in Bucket
  for (const chunk of dbConfirmed) {
    if (!bucketKeys.has(chunk.bucketKey)) {
      console.error(`❌ ERROR: Chunk ${chunk.chunkId} confirmed in DB but MISSING from bucket!`);
      inconsistencies++;
    }
  }

  // Bucket has object but DB doesn't have confirmed record
  const dbConfirmedKeys = new Set(dbConfirmed.map(c => c.bucketKey));
  for (const key of bucketKeys) {
    if (!dbConfirmedKeys.has(key)) {
      const isPending = dbPending.some(p => p.bucketKey === key);
      if (isPending) {
        console.warn(`⚠️  WARNING: Object ${key} exists in bucket but DB status is "pending"`);
      } else {
        console.warn(`⚠️  WARNING: Object ${key} exists in bucket but NO record found in DB!`);
      }
      inconsistencies++;
    }
  }

  if (inconsistencies === 0) {
    console.log("✅ SUCCESS: No data loss or inconsistencies detected.");
  } else {
    console.log(`\n❌ Total inconsistencies found: ${inconsistencies}`);
  }
}

const rid = process.argv[2];
if (!rid) {
  console.error("Usage: tsx validate-data-loss.ts <recordingId>");
  process.exit(1);
}

validate(rid).catch(console.error);
