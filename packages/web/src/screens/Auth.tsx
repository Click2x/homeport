import { type FormEvent, useState } from "react";
import { api } from "../api";
import { Banner, Button, errorText, Field } from "../components/ui";

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup(token.trim(), username.trim(), password);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow stack">
      <div className="center">
        <h1>Welcome to Homeport</h1>
        <p className="muted">
          Let's start by creating your account. It only takes a minute, and it keeps everyone else on your
          network out.
        </p>
      </div>
      <form className="card" onSubmit={submit}>
        <Banner title="Where do I find the setup code?">
          <p>
            Homeport printed a short code when it started. Open its log (in Docker Desktop, open the{" "}
            <b>homeport</b> container and look at <b>Logs</b>) and copy the code that looks like{" "}
            <code>K7QM-2XWB-9TDA</code>.
          </p>
        </Banner>
        <Field label="Setup code">
          {(id) => (
            <input
              id={id}
              className="code"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="XXXX-XXXX-XXXX"
            />
          )}
        </Field>
        <Field label="Choose a username" hint="Letters, numbers, dots, dashes or underscores.">
          {(id) => (
            <input
              id={id}
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <Field label="Choose a password" hint="At least 12 characters. A few random words works well.">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error && <Banner kind="error">{error}</Banner>}
        <Button type="submit" variant="primary" big busy={busy}>
          Create my account
        </Button>
      </form>
    </div>
  );
}

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow stack">
      <div className="center">
        <h1>Welcome back</h1>
        <p className="muted">Sign in to manage your home server.</p>
      </div>
      <form className="card" onSubmit={submit}>
        <Field label="Username">
          {(id) => (
            <input
              id={id}
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error && <Banner kind="error">{error}</Banner>}
        <Button type="submit" variant="primary" big busy={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
