import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { env } from "./env";
import { ensureExtensions } from "./db/client";
import { ApiError } from "./http";
import { securityHeadersPlugin } from "./security";
import { ensureAdminUser } from "./auth";
import { startAuditRetention } from "./audit";
import { authRoutes } from "./routes/auth";
import { itemRoutes } from "./routes/items";
import { transactionRoutes } from "./routes/transactions";
import { statsRoutes } from "./routes/stats";
import { subscribeStatsInvalidation } from "./stats.service";
import { feedRoutes } from "./routes/feed";
import { partnerRoutes } from "./routes/partners";
import { itemMappingRoutes } from "./routes/item-mappings";
import { auditRoutes, userRoutes } from "./routes/users";
import { raiRoutes } from "./routes/rai";
import { publicRoutes } from "./routes/public";

await ensureExtensions();
await ensureAdminUser();
subscribeStatsInvalidation();
startAuditRetention();

// batas global Content-Length (upload import XLSX 10MB + overhead multipart)
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const app = new Elysia()
  .use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Idempotency-Key", "X-Requested-With", "Authorization"],
    }),
  )
  .mapResponse(({ response, set, request }) => {
    // gzip JSON response di API — mapResponse menerima respons sudah-serialisasi (string)
    if (
      typeof response === "string" &&
      response.length > 512 &&
      request.headers.get("accept-encoding")?.includes("gzip")
    ) {
      set.headers["Content-Encoding"] = "gzip";
      set.headers["Vary"] = "Accept-Encoding";
      return new Response(Bun.gzipSync(response));
    }
  })
  .use(securityHeadersPlugin())
  .onBeforeHandle(({ request, set }) => {
    const method = request.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      set.status = 413;
      return { error: "Ukuran permintaan terlalu besar" };
    }

    const csrf = request.headers.get("X-Requested-With");
    const bearer = request.headers.get("Authorization");
    if (!csrf && !bearer) {
      set.status = 403;
      return { error: "Permintaan mutasi harus menyertakan header X-Requested-With" };
    }
  })
  .onError(({ code, error, set, request }) => {
    if (error instanceof ApiError) {
      set.status = error.status;
      return { error: error.message, code: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      const issues = (error as { all?: { message: string; path?: string }[] }).all;
      return {
        error: "Data tidak valid",
        details: (issues ?? []).map((i) => ({ path: i.path ?? "", message: i.message })),
      };
    }
    if (code === "PARSE") {
      set.status = 400;
      return { error: "Body tidak valid" };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Endpoint tidak ditemukan" };
    }
    console.error(`[error] ${request.method} ${request.url}`, error);
    set.status = 500;
    return { error: "Terjadi kesalahan pada server" };
  })
  .use(authRoutes)
  .use(itemRoutes)
  .use(transactionRoutes)
  .use(statsRoutes)
  .use(feedRoutes)
  .use(partnerRoutes)
  .use(itemMappingRoutes)
  .use(userRoutes)
  .use(auditRoutes)
  .use(raiRoutes)
  .use(publicRoutes);

const port = Number(env.PORT);

app.listen(
  { port, hostname: env.isProd ? "127.0.0.1" : "0.0.0.0" },
  () => {
    console.log(`[rims] API ready at http://${env.isProd ? "127.0.0.1" : "0.0.0.0"}:${port}`);
  },
);
