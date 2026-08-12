import { Elysia } from "elysia";
import { authGuard, requirePerm } from "../security";
import { getStats } from "../stats.service";

export const statsRoutes = new Elysia({ prefix: "/api" }).use(authGuard()).get(
  "/stats",
  async ({ user }) => {
    requirePerm(user, "stats:view");
    return getStats();
  },
);
