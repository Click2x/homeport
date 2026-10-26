import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Banner, Button, errorText, Field } from "../components/ui";
import type { AuditEntry } from "../types";

export function AccountScreen({ username }: { username: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    api
      .audit()
      .then((r) => setEntries(r.entries))
      .catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.changePassword(current, next);
      setMsg({ kind: "ok", text: "Password changed. Any other devices were signed out." });
      setCurrent("");
      setNext("");
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow stack">
      <h1>Your account</h1>
      <form className="card" onSubmit={submit}>
        <h2>Change password</h2>
        <p className="muted">Signed in as {username}.</p>
        <Field label="Current password">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
        </Field>
        <Field label="New password" hint="At least 12 characters.">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <Button type="submit" variant="primary" busy={busy}>
          Change password
        </Button>
      </form>

      <div className="card">
        <h2>Recent activity</h2>
        {entries.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="list">
            {entries.slice(0, 15).map((e) => (
              <li key={`${e.at}-${e.action}-${e.detail}`}>
                <span className="muted mono" style={{ flex: "none" }}>
                  {e.at.slice(0, 16).replace("T", " ")}
                </span>
                <span className="grow">
                  {e.actor}: {e.action}
                  {e.detail ? ` (${e.detail})` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
