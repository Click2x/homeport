import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import type { Catalog } from "@homeport/core";
import {
  CONFIG_TEMPLATE,
  ConfigError,
  composeToYaml,
  type DataLocation,
  decideVpn,
  docker,
  generateCompose,
  type HomeportConfig,
  parseConfig,
} from "@homeport/engine";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { DEPLOYED_KEY, type DeployOps, deploy } from "./deploy.js";
import { Jobs } from "./jobs.js";
import { allocatePorts } from "./ports.js";
import {
  appsForGoals,
  buildPlan,
  loadSettings,
  SETTINGS_KEY,
  UserError,
  validateSettingsInput,
} from "./settings.js";
import type { Store } from "./store.js";
import {
  clearVpnSettings,
  describeVpn,
  saveVpnSettings,
  setVpnVerified,
  vpnConfigured,
  vpnVerified,
} from "./vpn-settings.js";

export interface AppDeps {
  store: Store;
  catalog: Catalog;
  ops: DeployOps;
  dataDir: string;
  version: string;
  /** Printed at start-up; needed to create the first account. */
  setupToken: string | null;
  /** Folder of the built web interface, if any. */
  webDir?: string;
}

const CONFIG_FILE = "homeport.toml";

/** Reads homeport.toml, creating the commented starter file the first time. A broken file stops deploys, not the app. */
export function makeConfigLoader(dataDir: string): () => HomeportConfig {
  const path = join(dataDir, CONFIG_FILE);
  return () => {
    if (!existsSync(path)) writeFileSync(path, CONFIG_TEMPLATE);
    return parseConfig(readFileSync(path, "utf8"));
  };
}

const SettingsBody = Type.Object({
  goals: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  project: Type.Optional(Type.String({ maxLength: 40 })),
  data: Type.Optional(
    Type.Union([
      Type.Object({ mode: Type.Literal("volume") }),
      Type.Object({ mode: Type.Literal("bind"), source: Type.String({ maxLength: 400 }) }),
    ]),
  ),
  timezone: Type.Optional(Type.String({ maxLength: 60 })),
  puid: Type.Optional(Type.Integer()),
  pgid: Type.Optional(Type.Integer()),
  hostPorts: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()))),
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { store, catalog, ops, dataDir } = deps;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const jobs = new Jobs(store);
  store.failInterruptedJobs();
  const loadConfig = makeConfigLoader(dataDir);

  await app.register(fastifyCookie);

  // Browsers (and our own scripts) often send "Content-Type: application/json" with no body for actions
  // like "deploy". Treat that as an empty object instead of an error.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(Object.assign(new Error("The request was not valid JSON."), { statusCode: 400 }), undefined);
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (error instanceof UserError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof ConfigError) return reply.code(422).send({ error: error.message });
    if (error.validation)
      return reply.code(400).send({ error: "Some of the information sent was not valid." });
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: error.message });
    // Never leak internals to the browser; the message is enough for a person, the log has the rest.
    console.error(error);
    return reply
      .code(500)
      .send({ error: "Something went wrong inside Homeport. Check its log for details." });
  });

  registerAuth(app, { store, setupToken: deps.setupToken });
  const who = (req: { user: { username: string } | null }) => req.user?.username ?? "unknown";

  // ---- what is available ----
  app.get("/api/catalog", async () => ({
    goals: catalog.goals.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      apps: g.apps.map((id) => {
        const a = catalog.apps.get(id);
        return { id, name: a?.name ?? id, purpose: a?.purpose ?? "", needsVpn: a?.vpn === "required" };
      }),
    })),
  }));

  app.get("/api/system", async () => {
    const problem = await ops.checkDocker();
    if (problem) return { docker: { ok: false, problem } };
    const info = await docker(["info", "--format", "{{json .}}"]).then(
      (o) =>
        JSON.parse(o) as {
          OperatingSystem?: string;
          MemTotal?: number;
          NCPU?: number;
          ServerVersion?: string;
        },
      () => ({}) as { OperatingSystem?: string; MemTotal?: number; NCPU?: number; ServerVersion?: string },
    );
    return {
      docker: {
        ok: true,
        version: info.ServerVersion ?? null,
        desktop: /desktop/i.test(info.OperatingSystem ?? ""),
        memoryGB: info.MemTotal ? Math.round(info.MemTotal / 1024 ** 3) : null,
        cpus: info.NCPU ?? null,
      },
      version: deps.version,
    };
  });

  // ---- settings ----
  const describeSettings = () => {
    const s = loadSettings(store);
    let apps: string[] = [];
    try {
      apps = appsForGoals(catalog, s.goals);
    } catch {
      apps = [];
    }
    return { ...s, apps };
  };
  app.get("/api/settings", async () => describeSettings());
  app.put("/api/settings", { schema: { body: SettingsBody } }, async (req) => {
    const changes = validateSettingsInput(req.body as never, catalog);
    store.setJson(SETTINGS_KEY, { ...loadSettings(store), ...changes });
    store.audit(who(req), "settings", Object.keys(changes).join(", "));
    return describeSettings();
  });

  // ---- the VPN ----
  const vpnView = () => {
    const apps = describeSettings().apps;
    const config = safeConfig();
    const d = decideVpn(catalog, apps, config.config, {
      configured: vpnConfigured(store),
      verified: vpnVerified(store),
    });
    return {
      ...describeVpn(store, catalog),
      needed: d.vpn || d.unprotected,
      unprotected: d.unprotected,
      downloadsOnHold: d.hold.length > 0,
      message: d.message ?? null,
      configProblem: config.problem,
    };
  };
  function safeConfig(): { config: HomeportConfig; problem: string | null } {
    try {
      return { config: loadConfig(), problem: null };
    } catch (e) {
      if (e instanceof ConfigError)
        return { config: { downloads: { allowUnprotected: false } }, problem: e.message };
      throw e;
    }
  }
  app.get("/api/vpn", async () => vpnView());
  app.put(
    "/api/vpn",
    {
      schema: { body: Type.Object({ values: Type.Record(Type.String(), Type.String({ maxLength: 500 })) }) },
    },
    async (req) => {
      saveVpnSettings(store, catalog, (req.body as { values: Record<string, string> }).values);
      store.audit(who(req), "vpn-settings", "updated");
      return vpnView();
    },
  );
  app.delete("/api/vpn", async (req) => {
    clearVpnSettings(store);
    setVpnVerified(store, false);
    store.audit(who(req), "vpn-settings", "removed");
    return vpnView();
  });
  app.get("/api/config", async () => {
    const { config, problem } = safeConfig();
    return {
      file: join(dataDir, CONFIG_FILE),
      allowUnprotected: config.downloads.allowUnprotected,
      problem,
      note: "This file can only be changed by editing it by hand, then restarting Homeport.",
    };
  });

  // ---- plan preview and export ----
  const currentPlan = async () => {
    const s = loadSettings(store);
    const apps = appsForGoals(catalog, s.goals);
    if (!apps.length) throw new UserError("Choose what you want to do first.");
    const { config } = safeConfig();
    const d = decideVpn(catalog, apps, config, {
      configured: vpnConfigured(store),
      verified: vpnVerified(store),
    });
    const hostPorts = allocatePorts(catalog, apps, new Set(), s.hostPorts);
    return { plan: buildPlan(s, apps, { vpn: d.vpn, hold: d.hold, hostPorts }), decision: d };
  };
  app.get("/api/plan", async () => {
    const { plan, decision } = await currentPlan();
    return {
      services: plan.apps.map((id) => ({
        id,
        name: catalog.apps.get(id)?.name ?? id,
        purpose: catalog.apps.get(id)?.purpose ?? "",
      })),
      vpn: decision,
      ramMB: plan.apps.reduce((n, id) => n + (catalog.apps.get(id)?.ramMB ?? 0), 0),
    };
  });
  app.get("/api/compose", async (_req, reply) => {
    const { plan } = await currentPlan();
    reply.type("text/yaml").header("Content-Disposition", 'attachment; filename="compose.yaml"');
    return composeToYaml(generateCompose(catalog, plan));
  });

  // ---- storage ----
  const locationOf = (): DataLocation => {
    const s = loadSettings(store);
    return s.data.mode === "bind" ? s.data : { mode: "volume", project: s.project };
  };
  app.post("/api/storage/check", async () => {
    const s = loadSettings(store);
    const owner = { puid: s.puid, pgid: s.pgid };
    const problem = await ops.checkDocker();
    if (problem) throw new UserError(problem);
    await ops.prepareStorage(locationOf(), owner);
    return ops.checkStorage(locationOf(), owner);
  });
  app.post("/api/storage/fix", { schema: { body: Type.Object({ action: Type.String() }) } }, async (req) => {
    const { action } = req.body as { action: string };
    const s = loadSettings(store);
    if (action === "fix-permissions") {
      await ops.prepareStorage(locationOf(), { puid: s.puid, pgid: s.pgid });
      store.audit(who(req), "storage-fix", action);
      return { ok: true };
    }
    if (action === "enable-copy-mode") {
      // Sonarr and Radarr already copy when a link is impossible, so there is nothing to switch on.
      return { ok: true, note: "Your apps copy files automatically when linking is not possible." };
    }
    throw new UserError("Homeport does not know that fix.");
  });

  // ---- deploy and live progress ----
  app.post("/api/deploy", async (req, reply) => {
    const id = jobs.start(
      "deploy",
      async (report) => (await deploy({ store, catalog, ops, dataDir, loadConfig }, report)).summary,
    );
    store.audit(who(req), "deploy", id);
    return reply.code(202).send({ jobId: id });
  });

  app.get("/api/jobs/latest", async (req) => {
    const kind = String((req.query as { kind?: string }).kind ?? "deploy");
    const job = store.latestJob(kind);
    return { job: job ?? null, running: jobs.activeJob(kind) ?? null };
  });
  app.get("/api/jobs/:id", async (req) => {
    const job = store.getJob((req.params as { id: string }).id);
    if (!job) throw new UserError("That job does not exist.", 404);
    return { job, events: store.events(job.id) };
  });

  // Server-Sent Events: replays what was missed (Last-Event-ID), then streams live until the job ends.
  app.get("/api/jobs/:id/events", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = store.getJob(id);
    if (!job) throw new UserError("That job does not exist.", 404);
    const last = Number(req.headers["last-event-id"] ?? (req.query as { after?: string }).after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (e: { seq: number } & Record<string, unknown>) =>
      res.write(`id: ${e.seq}\nevent: progress\ndata: ${JSON.stringify(e)}\n\n`);
    const finish = () => {
      const row = store.getJob(id);
      res.write(`event: end\ndata: ${JSON.stringify({ status: row?.status, summary: row?.summary })}\n\n`);
      res.end();
    };
    res.write("retry: 3000\n\n");
    let sent = last;
    // Subscribe before replaying so no event falls between the two.
    const buffered: ({ seq: number } & Record<string, unknown>)[] = [];
    let ended = false;
    let replaying = true;
    const unsubscribe = jobs.subscribe(id, (event) => {
      if (event === null) {
        ended = true;
        if (!replaying) {
          clearInterval(beat);
          finish();
        }
        return;
      }
      if (replaying) buffered.push(event as never);
      else if (event.seq > sent) {
        sent = event.seq;
        send(event as never);
      }
    });
    for (const e of store.events(id, last)) {
      sent = e.seq;
      send(e as never);
    }
    for (const e of buffered)
      if (e.seq > sent) {
        sent = e.seq;
        send(e);
      }
    replaying = false;
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    const done = () => {
      clearInterval(beat);
      unsubscribe();
    };
    req.raw.on("close", done);
    if (ended || store.getJob(id)?.status !== "running") {
      done();
      finish();
    }
  });

  // ---- what is deployed now ----
  app.get("/api/stack", async () => {
    const s = loadSettings(store);
    const deployed = store.getJson<{ at: string; result: unknown }>(DEPLOYED_KEY) ?? null;
    let containers: { service: string; state: string; health: string }[] = [];
    try {
      const out = await docker([
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${s.project}`,
        "--format",
        '{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Status}}',
      ]);
      containers = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [service = "", state = "", status = ""] = l.split("|");
          return {
            service,
            state,
            health: /unhealthy/.test(status) ? "unhealthy" : /healthy/.test(status) ? "healthy" : "none",
          };
        });
    } catch {
      // Docker unreachable: show what we last knew.
    }
    return { deployed, containers };
  });

  app.get("/api/audit", async () => ({ entries: store.recentAudit(50) }));

  return app;
}
