import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { verifyAccessToken } from "./auth/jwt.js";
import { ADMIN_CHANNEL, type AppContext } from "./context.js";

const ADMIN_ROOM = "__admin";

/**
 * WebSocket gateway: sockets join per-auction rooms (or the admin firehose)
 * and receive the curated events the engine publishes via Redis pub/sub.
 * Payloads are already public-safe; this layer only routes.
 */
export async function registerWs(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(websocket);

  const rooms = new Map<string, Set<WebSocket>>();
  const join = (room: string, socket: WebSocket) => {
    (rooms.get(room) ?? rooms.set(room, new Set()).get(room)!).add(socket);
  };
  const leaveAll = (socket: WebSocket) => {
    for (const [room, members] of rooms) {
      members.delete(socket);
      if (members.size === 0) rooms.delete(room);
    }
  };
  const broadcast = (room: string, payload: string) => {
    const members = rooms.get(room);
    if (!members) return;
    for (const socket of members) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const sub = new Redis(ctx.config.redisUrl);
  await sub.psubscribe("auction:*");
  await sub.subscribe(ADMIN_CHANNEL);
  sub.on("pmessage", (_pattern, channel, message) => {
    broadcast(channel.slice("auction:".length), message);
  });
  sub.on("message", (channel, message) => {
    if (channel === ADMIN_CHANNEL) broadcast(ADMIN_ROOM, message);
  });
  app.addHook("onClose", async () => {
    await sub.quit().catch(() => undefined);
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    const claims = token ? verifyAccessToken(token, ctx.config.jwtSecret) : null;
    if (!claims) {
      socket.close(4001, "unauthenticated");
      return;
    }
    socket.on("message", (raw: Buffer) => {
      let msg: { type?: string; auctionId?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.auctionId === "string") {
        join(msg.auctionId, socket);
        socket.send(JSON.stringify({ type: "subscribed", auctionId: msg.auctionId }));
      } else if (msg.type === "subscribe_admin") {
        join(ADMIN_ROOM, socket);
        socket.send(JSON.stringify({ type: "subscribed", room: "admin" }));
      } else if (msg.type === "unsubscribe_all") {
        leaveAll(socket);
      }
    });
    socket.on("close", () => leaveAll(socket));
  });
}
