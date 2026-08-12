import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, ensureExtensions } from "./client";

await ensureExtensions();
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[db] migrations applied.");
process.exit(0);
