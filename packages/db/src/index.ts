import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const client = postgres(connectionString, { max: 100 });
export const db = drizzle(client, { schema });

export { chunkAcks, recordings } from "./schema.js";
export type { ChunkAck, NewChunkAck, Recording, NewRecording } from "./schema.js";
