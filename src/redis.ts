export const EVENT_CHANNEL = "rims:events";

export type FeedEvent =
  | { kind: "transaction:created"; data: Record<string, unknown> }
  | { kind: "transaction:voided"; data: Record<string, unknown> }
  | { kind: "item:updated"; data: Record<string, unknown> }
  | { kind: "item:deleted"; data: Record<string, unknown> }
  | { kind: "partner:updated"; data: Record<string, unknown> }
  | { kind: "partner:deleted"; data: Record<string, unknown> };

export const redis = Bun.redis;
const subscriber = new Bun.RedisClient();

export async function publishEvent(event: FeedEvent) {
  try {
    await redis.publish(EVENT_CHANNEL, JSON.stringify(event));
  } catch {
    // pub/sub failure must never break a successful write
  }
}

export function subscribeFeed(listener: (message: string, channel: string) => void) {
  subscriber.subscribe(EVENT_CHANNEL, listener);
}
