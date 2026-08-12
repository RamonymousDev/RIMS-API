import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const transactionType = pgEnum("transaction_type", ["in", "out"]);
export const partnerType = pgEnum("partner_type", ["customer", "supplier", "both"]);

export const businessPartners = pgTable(
  "business_partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: partnerType("type").notNull().default("customer"),
    person: text("person"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("business_partners_code_idx").on(t.code),
    index("business_partners_name_trgm_idx").using("gin", sql`name gin_trgm_ops`),
    index("business_partners_type_idx").on(t.type),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    permissions: jsonb("permissions").$type<Record<string, boolean>>().notNull().default({}),
    isBootstrap: boolean("is_bootstrap").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_idx").on(t.username)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    targetId: text("target_id"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_actor_idx").on(t.actorId),
  ],
);

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    model: text("model"),
    variant: text("variant"),
    unit: text("unit").notNull().default("pcs"),
    minStock: integer("min_stock").notNull().default(0),
    stock: integer("stock").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("items_sku_idx").on(t.sku),
    uniqueIndex("items_idempotency_key_idx").on(t.idempotencyKey),
    index("items_name_trgm_idx").using("gin", sql`name gin_trgm_ops`),
    index("items_sku_trgm_idx").using("gin", sql`sku gin_trgm_ops`),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    type: transactionType("type").notNull(),
    date: date("date").notNull().default(sql`CURRENT_DATE`),
    note: text("note"),
    partnerId: uuid("partner_id").references(() => businessPartners.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transactions_number_idx").on(t.number),
    uniqueIndex("transactions_idempotency_key_idx").on(t.idempotencyKey),
    index("transactions_type_created_idx").on(t.type, t.createdAt),
    index("transactions_partner_idx").on(t.partnerId),
  ],
);

export const transactionItems = pgTable(
  "transaction_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    qty: integer("qty").notNull(),
  },
  (t) => [
    index("transaction_items_transaction_idx").on(t.transactionId),
    index("transaction_items_item_idx").on(t.itemId),
    uniqueIndex("transaction_items_unique_line").on(t.transactionId, t.itemId),
  ],
);

export const counters = pgTable("counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull().default(0),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type TransactionItem = typeof transactionItems.$inferSelect;
