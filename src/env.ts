import * as v from "valibot";

const envSchema = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number)), "3001"),
  NODE_ENV: v.optional(v.picklist(["development", "production", "test"]), "development"),
  DATABASE_URL: v.optional(v.string(), "postgres://postgres:postgres@127.0.0.1:5432/rims"),
  REDIS_URL: v.optional(v.string(), "redis://127.0.0.1:6379"),
  ADMIN_USERNAME: v.optional(v.string(), "admin"),
  ADMIN_PASSWORD: v.optional(v.string(), "change-me"),
  COOKIE_DOMAIN: v.optional(v.string(), ""),
  WEB_ORIGIN: v.optional(v.string(), "http://localhost:5173"),
});

const parsed = v.parse(envSchema, process.env);

const password = parsed.ADMIN_PASSWORD;
if (password === "change-me" || password.length < 12) {
  console.warn(
    "[env] WARN: ADMIN_PASSWORD lemah/sedang default. Atur password kuat (min. 12 karakter) di .env sebelum produksi.",
  );
}

export const env = {
  ...parsed,
  isProd: parsed.NODE_ENV === "production",
};
