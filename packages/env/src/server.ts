import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const SERVER_ENV = createEnv({
  server: {
    DATABASE_URL: z.string(),
    BUCKET_ENDPOINT: z.string(),
    BUCKET_KEY: z.string(),
    BUCKET_SECRET: z.string(),
    BUCKET_NAME: z.string(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    BUCKET_ENDPOINT: process.env.BUCKET_ENDPOINT,
    BUCKET_KEY: process.env.BUCKET_KEY,
    BUCKET_SECRET: process.env.BUCKET_SECRET,
    BUCKET_NAME: process.env.BUCKET_NAME,
  },
});
