import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Banner, Button, errorText, Field, Spinner } from "../components/ui";
import type { Invite, Person, RemoteView, Shareable } from "../types";

const WHEN = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

export function phoneUrl(gateway: string, s: Shareable) {
  return `http://${gateway}:${s.port}`;
}

/** The QR code is plain SVG from Homeport itself; showing it as an image means it can never run script. */
const svgSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^A-Za-z0-9._-]+/g, "-") || "homeport"}.conf`;
  a.click();
  URL.revokeObjectURL(url);
}

function Welcome({ invite, view, onDone }: { invite: Invite; view: RemoteView; onDone: () => void }) {
  const [showText, setShowText] = useState(false);
  const apps = view.shareable.filter((s) => invite.person.services.includes(s.id));
  return (
    <div className="card stack">
      <h2>{invite.person.name} is invited</h2>
      <Banner kind="warn" title="This is the only time you will see this code">
        <p>
          The key that lets this phone in is made just now and is not kept anywhere. If it is lost, remove{" "}
          {invite.person.name} and invite them again.
        </p>
      </Banner>
      <div className="row" style={{ alignItems: "flex-start", gap: "1.5rem" }}>
        <img
          src={svgSrc(invite.qr)}
          alt={`QR code to add ${invite.person.name} to the WireGuard app`}
          width={220}
          height={220}
          style={{ background: "#fff", padding: "0.5rem", borderRadius: "var(--radius-sm)", flex: "none" }}
        />
        <ol style={{ flex: 1, minWidth: "16rem", margin: 0, paddingLeft: "1.2rem" }}>
          <li>
            On their phone, install the free <b>WireGuard</b> app (App Store or Google Play).
          </li>
          <li>
            In the app, tap <b>+</b>, then <b>Scan from QR code</b>, and point it at this code.
          </li>
          <li>
            Turn the tunnel on. It only carries traffic for your server; the rest of their phone is untouched.
          </li>
          <li>
            Then they can open:
            <ul>
              {apps.map((a) => (
                <li key={a.id}>
                  {a.name}: <span className="mono">{phoneUrl(view.gatewayAddress, a)}</span>
                </li>
              ))}
            </ul>
          </li>
        </ol>
      </div>
      {!invite.applied && <Banner kind="info">{invite.note}</Banner>}
      <div className="row">
        <Button onClick={() => download(invite.person.name, invite.config)}>Download the file instead</Button>
        <Button variant="quiet" onClick={() => setShowText((v) => !v)}>
          {showText ? "Hide the text" : "Show the text"}
        </Button>
        <span className="spacer" />
        <Button variant="primary" onClick={onDone}>
          I have set it up
        </Button>
      </div>
      {showText && <pre className="log">{invite.config}</pre>}
    </div>
  );
}

function InviteForm({ view, onInvite }: { view: RemoteView; onInvite: (i: Invite) => void }) {
  const friendly = view.shareable.filter((s) => !s.sensitive).map((s) => s.id);
  const [name, setName] = useState("");
  const [services, setServices] = useState<string[]>(friendly);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setServices((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invite = await api.invite({ name, services, ...(days ? { expiresInDays: Number(days) } : {}) });
      setName("");
      onInvite(invite);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Invite someone</h2>
      <p className="muted">
        Each person gets their own code, so you can cut one off without affecting anyone else.
      </p>
      <Field label="Who is it for?" hint="For example: Sam's phone. Just so you can tell them apart.">
        {(id) => (
          <input
            id={id}
            type="text"
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 1rem" }}>
        <legend>
          <b>What may they open?</b>
        </legend>
        {view.shareable.map((s) => (
          <label key={s.id} className="toggle" style={{ display: "flex" }}>
            <input type="checkbox" checked={services.includes(s.id)} onChange={() => toggle(s.id)} />
            <span>
              {s.name}
              {s.sensitive && (
                <span className="muted"> — an admin tool: this person could change your setup</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <Field label="How long should it last?">
        {(id) => (
          <select id={id} value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="">Until I remove it</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        )}
      </Field>
      {error && <Banner kind="error">{error}</Banner>}
      <Button type="submit" variant="primary" busy={busy} disabled={!view.shareable.length}>
        Create invitation
      </Button>
    </form>
  );
}

function PersonRow({ p, view, onChange }: { p: Person; view: RemoteView; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = view.shareable.filter((s) => p.services.includes(s.id)).map((s) => s.name);
  const remove = async () => {
    if (!window.confirm(`Remove ${p.name}? Their phone will stop working straight away.`)) return;
    setBusy(true);
    try {
      await api.removePerson(p.id);
      onChange();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <li>
      <div className="grow">
        <strong>{p.name}</strong>{" "}
        {p.online ? (
          <Badge kind="ok">Connected now</Badge>
        ) : p.lastSeen ? (
          <Badge>Last seen {WHEN(p.lastSeen)}</Badge>
        ) : (
          <Badge>Never connected</Badge>
        )}
        <div className="muted">{names.length ? `Can open: ${names.join(", ")}` : "No apps"}</div>
        {p.expiresAt && <div className="muted">Stops working on {WHEN(p.expiresAt)}</div>}
        {error && <Banner kind="error">{error}</Banner>}
      </div>
      <Button variant="quiet" busy={busy} onClick={remove}>
        Remove
      </Button>
    </li>
  );
}

export function RemoteScreen({ onApply }: { onApply: () => void }) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [port, setPort] = useState("51820");
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.remote();
      setView(v);
      setEndpoint((e) => e || v.endpoint);
      setPort(String(v.port));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  if (!view)
    return error ? (
      <Banner kind="error">{error}</Banner>
    ) : (
      <p className="center">
        <Spinner label="Loading" /> Loading…
      </p>
    );

  const save = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.saveRemote({ enabled, endpoint, port: Number(port) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const find = async () => {
    setFinding(true);
    try {
      const { ip } = await api.detectAddress();
      if (ip) setEndpoint(ip);
      else setError("Could not find your public address. Enter it by hand, or use a name that points to it.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setFinding(false);
    }
  };

  if (invite)
    return (
      <div className="narrow stack">
        <Welcome
          invite={invite}
          view={view}
          onDone={() => {
            setInvite(null);
            void load();
          }}
        />
      </div>
    );

  return (
    <div className="narrow stack">
      <div>
        <h1>Remote access</h1>
        <p className="muted">
          Let family and friends reach your apps from their phones, without opening your apps to the whole
          internet. Each person gets their own code and can open only what you allow.
        </p>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {!view.enabled ? (
        <div className="card stack">
          <h2>Turn it on</h2>
          <Banner title="Before you start">
            <p>
              This works by letting one port on your home router through to this computer (this is called
              "port forwarding"). It needs a router you can change, and it does not work on some internet
              connections (for example many mobile or shared connections). If your home internet address
              changes now and then, a free "dynamic DNS" name helps.
            </p>
          </Banner>
          <Field
            label="What will people connect to?"
            hint="Your public internet address, or a name that points to it."
          >
            {(id) => (
              <div className="row">
                <input
                  id={id}
                  type="text"
                  style={{ flex: 1, minWidth: "12rem" }}
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="home.example.com"
                />
                <Button busy={finding} onClick={find}>
                  Find my address
                </Button>
              </div>
            )}
          </Field>
          <Field label="Port" hint="Leave this unless something else on your network already uses it.">
            {(id) => (
              <input
                id={id}
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                style={{ maxWidth: "10rem" }}
              />
            )}
          </Field>
          <Button variant="primary" busy={busy} onClick={() => save(true)}>
            Turn on remote access
          </Button>
        </div>
      ) : (
        <>
          {view.needsApply && (
            <Banner kind="warn" title="One more step: apply your changes">
              <p>Remote access is saved, but it only starts after Homeport installs it.</p>
              <Button variant="primary" onClick={onApply}>
                Apply now
              </Button>
            </Banner>
          )}
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}>Status</h2>
              {view.live && !view.needsApply ? (
                <Badge kind="ok">On</Badge>
              ) : (
                <Badge kind="warn">Not running yet</Badge>
              )}
            </div>
            <p>
              People connect to <span className="mono">{view.endpoint}</span> on port{" "}
              <span className="mono">{view.port}</span> (UDP).
            </p>
            <Banner title="One thing to do on your router">
              <p>
                Forward <b>UDP port {view.port}</b> to this computer. Every router looks different; search for
                "port forwarding" and your router's name. Homeport cannot do this part for you.
              </p>
            </Banner>
            <div className="row">
              <Button busy={busy} onClick={() => save(false)}>
                Turn off
              </Button>
            </div>
          </div>

          <div className="card">
            <h2>People</h2>
            {view.people.length === 0 ? (
              <p className="muted">Nobody yet. Invite someone below.</p>
            ) : (
              <ul className="list">
                {view.people.map((p) => (
                  <PersonRow key={p.id} p={p} view={view} onChange={() => void load()} />
                ))}
              </ul>
            )}
          </div>

          <InviteForm view={view} onInvite={setInvite} />
        </>
      )}
    </div>
  );
}
