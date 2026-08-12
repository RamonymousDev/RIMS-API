import { Elysia, t } from "elysia";
import { ApiError } from "../http";
import { authGuard } from "../security";
import { subscribeFeed } from "../redis";

type Controller = ReadableStreamDefaultController<Uint8Array>;

const listeners = new Set<Controller>();

subscribeFeed((message) => {
  for (const controller of listeners) {
    try {
      controller.enqueue(new TextEncoder().encode(`data: ${message}\n\n`));
    } catch {
      listeners.delete(controller);
    }
  }
});

export const feedRoutes = new Elysia({ prefix: "/api" }).use(authGuard()).get(
  "/feed",
  ({ user }) => {
    if (!user) throw new ApiError(401, "Belum login");

    let ping: ReturnType<typeof setInterval> | null = null;
    let current: Controller | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        current = controller;
        listeners.add(controller);
        controller.enqueue(new TextEncoder().encode(`retry: 3000\n\n`));
        ping = setInterval(() => {
          if (current) {
            try {
              current.enqueue(new TextEncoder().encode(`: ping\n\n`));
            } catch {
              /* client gone */
            }
          }
        }, 15_000);
      },
      cancel() {
        if (current) listeners.delete(current);
        if (ping) clearInterval(ping);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
  { query: t.Object({}) },
);
