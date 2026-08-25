import { Elysia, t } from "elysia";
import { ApiError } from "../http";
import { authGuard } from "../security";
import { subscribeFeed } from "../redis";

type Controller = ReadableStreamDefaultController<Uint8Array>;

// kind event → permission minimum untuk menerima event tsb
const KIND_PERM: Record<string, string> = {
  "transaction:created": "transactions:view",
  "transaction:voided": "transactions:view",
  "item:updated": "items:view",
  "item:deleted": "items:view",
  "partner:updated": "partners:view",
  "partner:deleted": "partners:view",
};

type Listener = { controller: Controller; perms: Record<string, boolean> };

const listeners = new Set<Listener>();

subscribeFeed((message) => {
  let kind = "";
  try {
    kind = (JSON.parse(message) as { kind?: string }).kind ?? "";
  } catch {
    // pesan non-JSON — abaikan filter, jangan broadcast
    return;
  }
  const requiredPerm = KIND_PERM[kind];
  for (const listener of listeners) {
    if (requiredPerm && listener.perms?.[requiredPerm] !== true) continue;
    try {
      listener.controller.enqueue(new TextEncoder().encode(`data: ${message}\n\n`));
    } catch {
      listeners.delete(listener);
    }
  }
});

export const feedRoutes = new Elysia({ prefix: "/api" }).use(authGuard()).get(
  "/feed",
  ({ user }) => {
    if (!user) throw new ApiError(401, "Belum login");

    let ping: ReturnType<typeof setInterval> | null = null;
    let current: Controller | null = null;
    // snapshot permission saat koneksi dibuka; perubahan permission berlaku saat reconnect
    const listener: Listener = { controller: null!, perms: user.permissions ?? {} };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        current = controller;
        listener.controller = controller;
        listeners.add(listener);
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
        if (current) listeners.delete(listener);
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
