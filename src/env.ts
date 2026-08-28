import * as v from "valibot";

const envSchema = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number)), "3001"),
  NODE_ENV: v.optional(v.picklist(["development", "production", "test"]), "development"),
  DATABASE_URL: v.string(),
  REDIS_URL: v.string(),
  ADMIN_USERNAME: v.optional(v.string(), "admin"),
  ADMIN_PASSWORD: v.optional(v.string(), "change-me"),
  COOKIE_DOMAIN: v.optional(v.string(), ""),
  WEB_ORIGIN: v.optional(v.string(), "http://localhost:5173"),
  TRUST_PROXY: v.optional(v.picklist(["true", "false"]), "false"),
  PUBLIC_MAP_TOKEN: v.optional(v.string(), ""),
});

const parsed = v.parse(envSchema, process.env);

const password = parsed.ADMIN_PASSWORD;
if (password === "change-me" || password.length < 12) {
  console.warn(
    "[env] WARN: ADMIN_PASSWORD lemah/sedang default. Atur password kuat (min. 12 karakter) di .env sebelum produksi.",
  );
}

if (parsed.NODE_ENV === "production" && parsed.WEB_ORIGIN === "http://localhost:5173") {
  console.warn(
    "[env] WARN: WEB_ORIGIN masih default (http://localhost:5173) di mode produksi. " +
    "Set WEB_ORIGIN ke URL domain produksi untuk membatasi CORS dengan benar.",
  );
}

export const env = {
  ...parsed,
  isProd: parsed.NODE_ENV === "production",
  trustProxy: parsed.TRUST_PROXY === "true",
};
