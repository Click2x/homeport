import { randomUUID } from "node:crypto";
import { UserError } from "./settings.js";
import type { JobEvent, Store } from "./store.js";

type Listener = (event: JobEvent | null) => void;

/** What a running job reports through. Each call becomes one line of live progress. */
export interface JobReporter {
  /** Start a named step. */
  start(step: string, message: string): void;
  done(step: string, message: string): void;
  warn(step: string, message: string): void;
  info(step: string, message: string): void;
}

/**
 * Runs one long task at a time per kind, saves every progress line to the database (so a page
 * reload or reconnect can replay it) and pushes live lines to anyone watching.
 */
export class Jobs {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly active = new Map<string, string>(); // kind -> job id

  constructor(private readonly store: Store) {}

  activeJob(kind: string): string | undefined {
    return this.active.get(kind);
  }

  start(kind: string, work: (report: JobReporter) => Promise<string>): string {
    if (this.active.has(kind)) throw new UserError("That is already running. Wait for it to finish.", 409);
    const id = randomUUID();
    this.store.createJob(id, kind);
    this.active.set(kind, id);
    const emit = (status: JobEvent["status"], step: string, message: string) => {
      const event = this.store.addEvent(id, { step, status, message });
      for (const l of this.listeners.get(id) ?? []) l(event);
    };
    const report: JobReporter = {
      start: (step, message) => emit("running", step, message),
      done: (step, message) => emit("done", step, message),
      warn: (step, message) => emit("warn", step, message),
      info: (step, message) => emit("info", step, message),
    };
    // Detached on purpose: the request that started the job returns immediately.
    void (async () => {
      try {
        const summary = await work(report);
        this.store.finishJob(id, "succeeded", summary);
      } catch (e) {
        const message =
          e instanceof UserError
            ? e.message
            : `Something unexpected went wrong: ${e instanceof Error ? e.message : String(e)}`;
        const detail = (e as { detail?: string }).detail;
        emit("error", "failed", detail ? `${message}\n${detail}` : message);
        this.store.finishJob(id, "failed", message);
      } finally {
        this.active.delete(kind);
        for (const l of this.listeners.get(id) ?? []) l(null);
        this.listeners.delete(id);
      }
    })();
    return id;
  }

  /** Subscribe to live events. The callback gets null when the job ends. Returns an unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }
}
