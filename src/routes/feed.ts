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

// Batas koneksi SSE serentak — backstop terhadap kebocoran/storm.
const MAX_LISTENERS = 200;

type Listener = {
  controller: Controller;
  perms: Record<string, boolean>;
  // bersihkan SEMUA resource untuk koneksi ini (listener, interval, abort).
  cleanup: () => void;
};

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
      // koneksi busuk selama broadcast → bersihkan tuntas (listener + interval + abort).
      listener.cleanup();
    }
  }
});

export const feedRoutes = new Elysia({ prefix: "/api" }).use(authGuard()).get(
  "/feed",
  ({ user, request }) => {
    if (!user) throw new ApiError(401, "Belum login");
    // Jangan buka koneksi baru kalau sudah mencapai batas — beri tahu klien supaya
    // memundurkan retry-nya alih-alih menyedot memori.
    if (listeners.size >= MAX_LISTENERS) {
      throw new ApiError(503, "Terlalu banyak koneksi realtime");
    }

    let ping: ReturnType<typeof setInterval> | null = null;
    let current: Controller | null = null;
    let cleaned = false;
    // snapshot permission saat koneksi dibuka; perubahan permission berlaku saat reconnect
    const listener: Listener = { controller: null!, perms: user.permissions ?? {}, cleanup: () => {} };

    // Idempoten — aman dipanggil berkali-kali (abort, broadcast catch, cancel, ping error).
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      listeners.delete(listener);
      if (ping) {
        clearInterval(ping);
        ping = null;
      }
      if (current) {
        try {
          current.close();
        } catch {
          /* sudah ditutup */
        }
        current = null;
      }
      // Hapus pendengar abort agar tidak menumpuk setelah dibersihkan.
      try {
        request.signal.removeEventListener("abort", cleanup);
      } catch {
        /* signal tidak mendukung removeEventListener */
      }
    };
    listener.cleanup = cleanup;

    // Pembersihan saat klien memutus koneksi. `ReadableStream.cancel()` tidak
    // dapat diandalkan di Bun/Elysia (oven/bun#6758, oven-sh/bun#14390,
    // elysiajs/elysia#1768), jadi pakai request signal sebagai sumber utama.
    try {
      request.signal.addEventListener("abort", cleanup);
    } catch {
      /* signal tanpa addEventListener — andalkan cancel() */
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        current = controller;
        listener.controller = controller;
        listeners.add(listener);
        controller.enqueue(new TextEncoder().encode(`retry: 3000\n\n`));
        ping = setInterval(() => {
          if (!current) return;
          try {
            current.enqueue(new TextEncoder().encode(`: ping\n\n`));
          } catch {
            // klien hilang → bersihkan, bukan menelan error (sumber kebocoran memori).
            cleanup();
          }
        }, 15_000);
      },
      cancel() {
        cleanup();
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
