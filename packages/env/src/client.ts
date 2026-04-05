import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const CLIENT_ENV = createEnv({
  client: {
    NEXT_PUBLIC_SERVER_URL: z.string().url(),
  },
  runtimeEnv: {
    NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL,
  },
});
