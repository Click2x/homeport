import { useCallback, useEffect, useRef, useState } from "react";
import { api, watchJob } from "../api";
import { Banner, Button, errorText, Spinner } from "../components/ui";
import type { JobEvent } from "../types";

const STEPS: { id: string; label: string; optional?: boolean }[] = [
  { id: "docker", label: "Checking that Docker is ready" },
  { id: "plan", label: "Choosing ports and preparing the plan" },
  { id: "pull", label: "Downloading the apps" },
  { id: "start", label: "Starting the apps" },
  { id: "storage", label: "Checking where your library will live" },
  { id: "network", label: "Connecting Homeport to the apps" },
  { id: "vpn", label: "Making sure downloads are protected" },
  { id: "remote", label: "Setting up remote access", optional: true },
  { id: "wire", label: "Linking the apps to each other" },
  { id: "profiles", label: "Setting up quality profiles" },
  { id: "requests", label: "Connecting the request page" },
];

type StepState = "pending" | "running" | "done" | "warn";

/** The latest state of each step, from the stream of events so far. */
export function stepStates(events: JobEvent[]): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const e of events) {
    const prev = out[e.step];
    if (e.status === "running") out[e.step] = "running";
    else if (e.status === "done") out[e.step] = prev === "warn" ? "warn" : "done";
    else if (e.status === "warn") out[e.step] = "warn";
  }
  return out;
}

const ICON: Record<StepState, string> = { pending: "○", running: "", done: "✓", warn: "!" };

export function InstallScreen({
  onBack,
  onDone,
  deployedBefore,
}: {
  onBack: () => void;
  onDone: () => void;
  deployedBefore: boolean;
}) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [phase, setPhase] = useState<"ready" | "running" | "succeeded" | "failed">("ready");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<() => void>(() => {});

  const follow = useCallback((jobId: string) => {
    setEvents([]);
    setPhase("running");
    stop.current();
    stop.current = watchJob(
      jobId,
      (e) => setEvents((list) => (list.some((x) => x.seq === e.seq) ? list : [...list, e])),
      (result) => {
        setPhase(result.status === "succeeded" ? "succeeded" : "failed");
        setSummary(result.summary);
      },
    );
  }, []);

  // If an install is already under way (for example the page was reloaded), pick it up where it is.
  useEffect(() => {
    api
      .latestJob()
      .then((r) => {
        if (r.running) follow(r.running);
      })
      .catch(() => {});
    return () => stop.current();
  }, [follow]);

  const start = async () => {
    setError(null);
    try {
      follow((await api.deploy()).jobId);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const states = stepStates(events);
  const warnings = events.filter((e) => e.status === "warn");
  const failure = events.find((e) => e.status === "error");

  return (
    <div className="narrow stack">
      <div>
        <h1>
          {phase === "ready"
            ? deployedBefore
              ? "Apply your changes"
              : "Ready to install"
            : "Setting things up"}
        </h1>
        <p className="muted">
          {phase === "ready"
            ? "Homeport will download the apps, start them, and connect them to each other. The first time takes a few minutes, mostly downloading."
            : "You can leave this page open. If you close it, Homeport keeps going and you can come back to see how it did."}
        </p>
      </div>

      {phase === "ready" && (
        <>
          {error && <Banner kind="error">{error}</Banner>}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Button onClick={onBack}>Back</Button>
            <Button variant="primary" big onClick={start}>
              {deployedBefore ? "Apply changes" : "Install now"}
            </Button>
          </div>
        </>
      )}

      {phase !== "ready" && (
        <div className="card">
          <ol className="list progress" aria-live="polite">
            {STEPS.filter((s) => !s.optional || states[s.id]).map((s) => {
              const st = states[s.id] ?? "pending";
              return (
                <li key={s.id}>
                  <span className="status" aria-hidden="true">
                    {st === "running" ? <Spinner /> : ICON[st]}
                  </span>
                  <span className="grow" style={{ color: st === "pending" ? "var(--muted)" : undefined }}>
                    {s.label}
                    <span className="sr-only"> — {st}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {phase === "succeeded" && (
        <Banner kind={warnings.length ? "warn" : "ok"} title={summary ?? "Done"}>
          {warnings.length > 0 && <p>There are a few things to know. They are listed below.</p>}
        </Banner>
      )}
      {phase === "failed" && (
        <Banner kind="error" title="That did not finish">
          <p>{summary}</p>
          <p>
            Nothing is broken: you can fix the problem and try again, and Homeport will pick up where it can.
          </p>
        </Banner>
      )}

      {warnings.length > 0 && (
        <div className="card">
          <h2>Things to know</h2>
          <ul>
            {warnings.map((w) => (
              <li key={w.seq}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {events.length > 0 && (
        <details>
          <summary>Show the full log</summary>
          <pre className="log">
            {events.map((e) => `${e.at.slice(11, 19)}  ${e.status.padEnd(7)} ${e.message}`).join("\n")}
            {failure && ""}
          </pre>
        </details>
      )}

      {(phase === "succeeded" || phase === "failed") && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          {phase === "failed" ? (
            <>
              <Button onClick={onBack}>Back</Button>
              <Button variant="primary" big onClick={start}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <span />
              <Button variant="primary" big onClick={onDone}>
                Go to my dashboard
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
