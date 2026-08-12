import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { env } from "./env";
import { ensureExtensions } from "./db/client";
import { ApiError } from "./http";
import { securityHeadersPlugin } from "./security";
import { ensureAdminUser } from "./auth";
import { authRoutes } from "./routes/auth";
import { itemRoutes } from "./routes/items";
import { transactionRoutes } from "./routes/transactions";
import { statsRoutes } from "./routes/stats";
import { subscribeStatsInvalidation } from "./stats.service";
import { feedRoutes } from "./routes/feed";
import { partnerRoutes } from "./routes/partners";
import { auditRoutes, userRoutes } from "./routes/users";

await ensureExtensions();
await ensureAdminUser();
subscribeStatsInvalidation();

const app = new Elysia()
  .use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Idempotency-Key", "X-Requested-With", "Authorization"],
    }),
  )
  .onAfterHandle(({ response, set, request }) => {
    if (response instanceof Response) return;
    if (
      typeof response === "string" &&
      request.headers.get("accept-encoding")?.includes("gzip") &&
      response.length > 512
    ) {
      const headers = new Headers({ "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(Bun.gzipSync(response), { headers });
    }
  })
  .use(securityHeadersPlugin())
  .onBeforeHandle(({ request, set }) => {
    const method = request.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
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
  .use(userRoutes)
  .use(auditRoutes);

const port = Number(env.PORT);

app.listen(port, () => {
  console.log(`[rims] API ready at http://localhost:${port}`);
});
