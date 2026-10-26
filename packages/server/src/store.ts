import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadOrCreateKey, randomToken, SecretBox, sha256 } from "./crypto.js";

export interface User {
  id: number;
  username: string;
  passwordHash: string;
}

export interface JobEvent {
  seq: number;
  at: string;
  step: string;
  status: "running" | "done" | "warn" | "error" | "info";
  message: string;
}

export interface JobRow {
  id: string;
  kind: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
}

const SESSION_DAYS = 7;
const now = () => new Date().toISOString();

/** Everything Homeport remembers lives in one SQLite file plus one key file, both in the data folder. */
export class Store {
  readonly box: SecretBox;
  private constructor(
    private readonly db: DatabaseSync,
    box: SecretBox,
  ) {
    this.box = box;
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, summary TEXT);
      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, step TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY (job_id, seq));
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    `);
  }

  static open(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true });
    const box = new SecretBox(loadOrCreateKey(join(dataDir, "secret.key")));
    return new Store(new DatabaseSync(join(dataDir, "homeport.db")), box);
  }

  static memory(): Store {
    return new Store(new DatabaseSync(":memory:"), new SecretBox(Buffer.alloc(32, 7)));
  }

  close(): void {
    this.db.close();
  }

  // ---- settings ----
  getJson<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setJson(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  // ---- secrets (encrypted at rest) ----
  getSecret(name: string): string | undefined {
    const row = this.db.prepare("SELECT sealed FROM secrets WHERE name = ?").get(name) as
      | { sealed: string }
      | undefined;
    return row ? this.box.open(row.sealed) : undefined;
  }
  setSecret(name: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO secrets (name, sealed) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET sealed = excluded.sealed",
      )
      .run(name, this.box.seal(value));
  }
  deleteSecret(name: string): void {
    this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
  }
  secretNames(prefix = ""): string[] {
    return (
      this.db.prepare("SELECT name FROM secrets WHERE name LIKE ?").all(`${prefix}%`) as { name: string }[]
    ).map((r) => r.name);
  }
  /** A generated secret that stays the same forever once created (API keys, service passwords). */
  ensureSecret(name: string, make: () => string = () => randomToken(16)): string {
    const have = this.getSecret(name);
    if (have !== undefined) return have;
    const fresh = make();
    this.setSecret(name, fresh);
    return fresh;
  }

  // ---- users and sessions ----
  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }
  createUser(username: string, passwordHash: string): number {
    const r = this.db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, passwordHash, now());
    return Number(r.lastInsertRowid);
  }
  findUser(username: string): User | undefined {
    const row = this.db
      .prepare("SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?")
      .get(username) as User | undefined;
    return row;
  }
  updatePassword(userId: number, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  }

  createSession(userId: number): string {
    const token = randomToken(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), userId, expires);
    return token;
  }
  /** Only a hash of the token is stored, so a copied database cannot be used to sign in. */
  findSession(token: string): { userId: number; username: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT s.user_id AS userId, u.username AS username, s.expires_at AS expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
      )
      .get(sha256(token)) as { userId: number; username: string; expires: string } | undefined;
    if (!row) return undefined;
    if (row.expires < now()) {
      this.deleteSession(token);
      return undefined;
    }
    return { userId: row.userId, username: row.username };
  }
  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
  deleteUserSessions(userId: number): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  // ---- jobs ----
  createJob(id: string, kind: string): void {
    this.db
      .prepare("INSERT INTO jobs (id, kind, status, started_at) VALUES (?, ?, 'running', ?)")
      .run(id, kind, now());
  }
  finishJob(id: string, status: "succeeded" | "failed", summary: string): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, finished_at = ?, summary = ? WHERE id = ?")
      .run(status, now(), summary, id);
  }
  getJob(id: string): JobRow | undefined {
    return this.db
      .prepare(
        "SELECT id, kind, status, started_at AS startedAt, finished_at AS finishedAt, summary FROM jobs WHERE id = ?",
      )
      .get(id) as JobRow | undefined;
  }
  latestJob(kind: string): JobRow | undefined {
    return this.db
      .prepare(
        "SELECT id, kind, status, started_at AS startedAt, finished_at AS finishedAt, summary FROM jobs WHERE kind = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(kind) as JobRow | undefined;
  }
  /** A restart kills any job that was running; mark it so the interface does not wait forever. */
  failInterruptedJobs(): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'failed', finished_at = ?, summary = 'Homeport restarted while this was running.' WHERE status = 'running'",
      )
      .run(now());
  }
  addEvent(jobId: string, e: Omit<JobEvent, "seq" | "at">): JobEvent {
    const seq =
      ((
        this.db.prepare("SELECT MAX(seq) AS m FROM job_events WHERE job_id = ?").get(jobId) as {
          m: number | null;
        }
      ).m ?? 0) + 1;
    const at = now();
    this.db
      .prepare("INSERT INTO job_events (job_id, seq, at, step, status, message) VALUES (?, ?, ?, ?, ?, ?)")
      .run(jobId, seq, at, e.step, e.status, e.message);
    return { seq, at, ...e };
  }
  events(jobId: string, afterSeq = 0): JobEvent[] {
    return this.db
      .prepare(
        "SELECT seq, at, step, status, message FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq",
      )
      .all(jobId, afterSeq) as unknown as JobEvent[];
  }

  // ---- audit log ----
  audit(actor: string, action: string, detail = ""): void {
    this.db
      .prepare("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)")
      .run(now(), actor, action, detail);
  }
  recentAudit(limit = 50): { at: string; actor: string; action: string; detail: string }[] {
    return this.db
      .prepare("SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as {
      at: string;
      actor: string;
      action: string;
      detail: string;
    }[];
  }
}
