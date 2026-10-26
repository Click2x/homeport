import { useState } from "react";
import { api } from "../api";
import { Badge, Banner, Button, errorText, Field } from "../components/ui";
import type { Settings, StorageReport, StorageResult, Tier } from "../types";

export const TIER_TEXT: Record<Tier, { label: string; text: string; kind: "ok" | "warn" | "error" }> = {
  best: {
    label: "Best",
    text: "Fast and safe, and downloads are linked into your library without copying.",
    kind: "ok",
  },
  good: { label: "Good", text: "Works well, with a few things worth knowing.", kind: "ok" },
  compatible: {
    label: "Compatible",
    text: "Works, but finished downloads will be copied and things may be slower.",
    kind: "warn",
  },
  blocked: {
    label: "Not ready",
    text: "Something must be fixed before Homeport can use this location.",
    kind: "error",
  },
};

const MARK = { pass: "✓", warn: "!", fail: "✕" } as const;

function Result({ r, onFix }: { r: StorageResult; onFix: (action: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <li>
      <span
        className={`badge ${r.status === "pass" ? "ok" : r.status === "warn" ? "warn" : "error"}`}
        aria-hidden="true"
      >
        {MARK[r.status]}
      </span>
      <div className="grow">
        <strong>{r.title}</strong>
        <span className="sr-only">
          {" "}
          ({r.status === "pass" ? "fine" : r.status === "warn" ? "worth knowing" : "problem"})
        </span>
        <div>{r.summary}</div>
        {r.fix?.kind === "auto" && (
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onFix((r.fix as { action: string }).action);
              } finally {
                setBusy(false);
              }
            }}
          >
            {r.fix.label}
          </Button>
        )}
        {r.fix?.kind === "guided" && (
          <details style={{ marginTop: "0.5rem" }}>
            <summary>{r.fix.label}</summary>
            <ul>
              {r.fix.steps.map((s) => (
                <li key={s} style={{ display: "list-item", border: 0, padding: 0 }}>
                  {s}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

export function StorageScreen({
  settings,
  onSettings,
  onBack,
  onNext,
}: {
  settings: Settings;
  onSettings: (s: Settings) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [mode, setMode] = useState<"volume" | "bind">(settings.data.mode);
  const [path, setPath] = useState(settings.data.mode === "bind" ? settings.data.source : "");
  const [report, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () =>
    onSettings(
      await api.saveSettings({
        data: mode === "bind" ? { mode: "bind", source: path.trim() } : { mode: "volume" },
      }),
    );

  const check = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      if (mode === "bind" && !path.trim()) throw new Error("Enter the folder you want to use.");
      await save();
      setReport(await api.checkStorage());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const fix = async (action: string) => {
    try {
      await api.fixStorage(action);
      setReport(await api.checkStorage());
    } catch (e) {
      setError(errorText(e));
    }
  };

  const tier = report ? TIER_TEXT[report.tier] : null;
  return (
    <div className="narrow stack">
      <div>
        <h1>Where should your library live?</h1>
        <p className="muted">
          This is where downloads and your movies and shows are kept. Homeport tests the location so there are
          no surprises later.
        </p>
      </div>

      <div className="stack">
        <button
          type="button"
          className="choice"
          aria-pressed={mode === "volume"}
          onClick={() => setMode("volume")}
        >
          <strong>Docker's own storage</strong>
          <span className="muted">
            The quickest way to start, and very fast. Good for trying Homeport. If you ever reset or uninstall
            Docker Desktop, the library is deleted with it.
          </span>
        </button>
        <button
          type="button"
          className="choice"
          aria-pressed={mode === "bind"}
          onClick={() => setMode("bind")}
        >
          <strong>A folder I choose</strong>
          <span className="muted">
            Keep your library on a drive you control, so it survives a Docker reset. Slower on some Windows
            setups.
          </span>
        </button>
      </div>

      {mode === "bind" && (
        <Field
          label="Folder"
          hint="For example D:\Media on Windows or /srv/media on Linux. Use a drive with plenty of free space."
        >
          {(id) => <input id={id} type="text" value={path} onChange={(e) => setPath(e.target.value)} />}
        </Field>
      )}

      {error && <Banner kind="error">{error}</Banner>}

      <div className="row">
        <Button variant={report ? "default" : "primary"} busy={busy} onClick={check}>
          {report ? "Check again" : "Check this location"}
        </Button>
        {busy ? (
          <span className="muted">
            Testing your storage. This can take up to a minute on a busy computer.
          </span>
        ) : (
          !report && <span className="muted">Takes a short while. Nothing of yours is changed.</span>
        )}
      </div>

      {report && tier && (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>Result</h2>
            <Badge kind={tier.kind}>{tier.label}</Badge>
          </div>
          <p>{tier.text}</p>
          <ul className="list">
            {report.results.map((r) => (
              <Result key={r.id} r={r} onFix={fix} />
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ justifyContent: "space-between" }}>
        <Button onClick={onBack}>Back</Button>
        <Button
          variant="primary"
          big
          disabled={report?.tier === "blocked"}
          onClick={async () => {
            try {
              await save();
              onNext();
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          {report ? "Continue" : "Skip the check and continue"}
        </Button>
      </div>
    </div>
  );
}
