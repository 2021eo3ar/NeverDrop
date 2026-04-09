import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { SERVER_ENV } from "./packages/env/src/server.ts";

const s3 = new S3Client({
  endpoint: SERVER_ENV.BUCKET_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: SERVER_ENV.BUCKET_KEY,
    secretAccessKey: SERVER_ENV.BUCKET_SECRET,
  },
  forcePathStyle: true,
});

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: SERVER_ENV.BUCKET_NAME }));
    console.log(`Bucket "${SERVER_ENV.BUCKET_NAME}" exists.`);
  } catch (error) {
    console.log(`Bucket "${SERVER_ENV.BUCKET_NAME}" missing, creating...`);
    await s3.send(new CreateBucketCommand({ Bucket: SERVER_ENV.BUCKET_NAME }));
    console.log("Bucket created.");
  }
}

ensureBucket().catch(console.error);
