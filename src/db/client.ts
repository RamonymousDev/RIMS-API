import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/rims";

const client = postgres(url, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});

export const db = drizzle(client);

export async function ensureExtensions() {
  await client.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
}

export const sqlClient = client;
