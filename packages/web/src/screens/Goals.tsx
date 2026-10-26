import { useState } from "react";
import { api } from "../api";
import { Banner, Button, errorText } from "../components/ui";
import type { Goal, Settings } from "../types";

export function GoalsScreen({
  goals,
  settings,
  onSaved,
}: {
  goals: Goal[];
  settings: Settings;
  onSaved: (s: Settings) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(settings.goals);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.saveSettings({ goals: chosen }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow stack">
      <div className="center">
        <h1>What would you like to do?</h1>
        <p className="muted">
          Pick what sounds good. Homeport sets up everything for it and connects the pieces, so you never have
          to copy keys between apps.
        </p>
      </div>

      <div className="stack">
        {goals.map((g) => (
          <button
            key={g.id}
            type="button"
            className="choice"
            aria-pressed={chosen.includes(g.id)}
            onClick={() => toggle(g.id)}
          >
            <strong>{g.title}</strong>
            <span className="muted">{g.description}</span>
            <span className="muted" style={{ display: "block", marginTop: "0.5rem", fontSize: "0.9rem" }}>
              Includes: {g.apps.map((a) => a.name).join(", ")}
            </span>
          </button>
        ))}
      </div>

      <Banner>
        <p>
          More choices, like photo backup, ad blocking and smart-home tools, are on the way. This first one
          works from start to finish today.
        </p>
      </Banner>

      {error && <Banner kind="error">{error}</Banner>}
      <div className="row end">
        <Button variant="primary" big disabled={chosen.length === 0} busy={busy} onClick={next}>
          Continue
        </Button>
      </div>
    </div>
  );
}
