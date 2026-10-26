import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, safeEqual, verifyPassword } from "./crypto.js";
import { UserError } from "./settings.js";
import type { Store } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    user: { id: number; username: string } | null;
  }
}

export const SESSION_COOKIE = "hp_session";
const WEEK_SECONDS = 7 * 24 * 3600;
const PUBLIC = new Set(["/api/status", "/api/setup", "/api/login"]);

const USERNAME = /^[A-Za-z0-9._-]{3,32}$/;
export const MIN_PASSWORD = 12;

/** Plain-language rules for the admin password. Returns a problem to show, or null. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `Use at least ${MIN_PASSWORD} characters. A few random words works well.`;
  if (password.toLowerCase().includes(username.toLowerCase()))
    return "Your password should not contain your username.";
  if (/^(.)\1+$/.test(password)) return "That password is too repetitive.";
  return null;
}

/** Counts failed attempts per address and says when to try again. In memory: a restart clears it. */
export class AttemptLimiter {
  private readonly tries = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait, or 0 if the caller may try. */
  blockedFor(key: string): number {
    const t = this.tries.get(key);
    if (!t) return 0;
    if (t.until <= this.now()) {
      this.tries.delete(key);
      return 0;
    }
    return t.count >= this.max ? Math.ceil((t.until - this.now()) / 1000) : 0;
  }
  fail(key: string): void {
    const t = this.tries.get(key);
    if (!t || t.until <= this.now()) this.tries.set(key, { count: 1, until: this.now() + this.windowMs });
    else t.count++;
  }
  succeed(key: string): void {
    this.tries.delete(key);
  }
}

export interface AuthOptions {
  store: Store;
  /** One-time code printed at start-up; required to create the first account. Null once an account exists. */
  setupToken: string | null;
  limiter?: AttemptLimiter;
}

export function registerAuth(
  app: FastifyInstance,
  options: AuthOptions,
): { setupToken: () => string | null } {
  const { store } = options;
  const limiter = options.limiter ?? new AttemptLimiter();
  let setupToken = store.userCount() === 0 ? options.setupToken : null;

  app.decorateRequest("user", null);

  const startSession = (req: FastifyRequest, reply: FastifyReply, userId: number) => {
    const token = store.createSession(userId);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: WEEK_SECONDS,
      secure: req.protocol === "https",
    });
  };

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");

    if (req.method !== "GET" && req.method !== "HEAD") {
      // A page on another site cannot add this header without a permission check we never grant.
      if (req.headers["x-homeport"] !== "1") return reply.code(403).send({ error: "Request not allowed." });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return reply.code(403).send({ error: "Request not allowed." });
    }

    const token = req.cookies[SESSION_COOKIE];
    const session = token ? store.findSession(token) : undefined;
    req.user = session ? { id: session.userId, username: session.username } : null;
    if (!req.user && !PUBLIC.has(path)) return reply.code(401).send({ error: "Please sign in." });
  });

  app.get("/api/status", async (req) => ({
    setupRequired: store.userCount() === 0,
    authenticated: Boolean(req.user),
    username: req.user?.username ?? null,
  }));

  app.post(
    "/api/setup",
    {
      schema: {
        body: Type.Object({ token: Type.String(), username: Type.String(), password: Type.String() }),
      },
    },
    async (req, reply) => {
      const { token, username, password } = req.body as { token: string; username: string; password: string };
      if (store.userCount() > 0 || !setupToken)
        throw new UserError("Homeport is already set up. Sign in instead.", 409);
      const wait = limiter.blockedFor(req.ip);
      if (wait) throw new UserError(`Too many tries. Wait ${wait} seconds and try again.`, 429);
      if (!safeEqual(token.trim(), setupToken)) {
        limiter.fail(req.ip);
        throw new UserError("That setup code is not right. Copy it from Homeport's log again.", 403);
      }
      if (!USERNAME.test(username))
        throw new UserError("Choose a username of 3 to 32 letters, numbers, dots, dashes or underscores.");
      const problem = passwordProblem(password, username);
      if (problem) throw new UserError(problem);
      const id = store.createUser(username, await hashPassword(password));
      setupToken = null;
      store.audit(username, "setup", "created the administrator account");
      startSession(req, reply, id);
      return { ok: true, username };
    },
  );

  // Checked against a real hash even when the user does not exist, so timing does not reveal valid usernames.
  const dummyHash = hashPassword("homeport-timing-equaliser");

  app.post(
    "/api/login",
    { schema: { body: Type.Object({ username: Type.String(), password: Type.String() }) } },
    async (req, reply) => {
      const { username, password } = req.body as { username: string; password: string };
      const wait = limiter.blockedFor(req.ip);
      if (wait)
        throw new UserError(`Too many tries. Wait ${Math.ceil(wait / 60)} minutes and try again.`, 429);
      const user = store.findUser(username);
      const ok = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
      if (!user || !ok) {
        limiter.fail(req.ip);
        store.audit(username.slice(0, 32), "login-failed", `from ${req.ip}`);
        throw new UserError("That username or password is not right.", 401);
      }
      limiter.succeed(req.ip);
      startSession(req, reply, user.id);
      store.audit(user.username, "login");
      return { ok: true, username: user.username };
    },
  );

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) store.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    if (req.user) store.audit(req.user.username, "logout");
    return { ok: true };
  });

  app.post(
    "/api/password",
    { schema: { body: Type.Object({ current: Type.String(), next: Type.String() }) } },
    async (req, reply) => {
      const { current, next } = req.body as { current: string; next: string };
      const me = req.user;
      if (!me) throw new UserError("Please sign in.", 401);
      const user = store.findUser(me.username);
      if (!user || !(await verifyPassword(current, user.passwordHash)))
        throw new UserError("Your current password is not right.", 403);
      const problem = passwordProblem(next, me.username);
      if (problem) throw new UserError(problem);
      store.updatePassword(user.id, await hashPassword(next));
      store.deleteUserSessions(user.id); // signs out every other device
      startSession(req, reply, user.id);
      store.audit(me.username, "password-changed");
      return { ok: true };
    },
  );

  return { setupToken: () => setupToken };
}
