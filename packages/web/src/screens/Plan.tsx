import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Banner, Button, errorText, Field, Spinner } from "../components/ui";
import { VpnForm } from "../components/VpnForm";
import type { PlanView, Settings, VpnView } from "../types";
import { providerLabel } from "../vpn";

function VpnSection({
  vpn,
  onChange,
  configFile,
}: {
  vpn: VpnView;
  onChange: (v: VpnView) => void;
  configFile: string;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (vpn.unprotected)
    return (
      <div className="card">
        <h2>Downloads without a VPN</h2>
        <Banner kind="warn" title="The VPN requirement is switched off">
          <p>
            Your settings file (<code>{configFile}</code>) says to run downloads <b>without</b> a VPN. Your
            home address will be visible to everyone you share files with, and your internet provider can see
            it. You are responsible for what you download and for the laws that apply to you.
          </p>
          <p>
            To turn protection back on, set <code>allow_unprotected = false</code> in that file and restart
            Homeport.
          </p>
        </Banner>
      </div>
    );

  return (
    <div className="card">
      <h2>Downloads need a VPN</h2>
      <p>
        Downloading with BitTorrent shows your home internet address to everyone sharing the same file, and
        your internet provider can see it too. So Homeport only runs the download client behind a VPN that it
        has tested and confirmed is working.
      </p>
      <p className="muted">
        If you skip this for now, everything else is still set up and downloads simply stay off until a VPN
        works. You are responsible for what you download and for the laws that apply to you.
      </p>

      {vpn.configProblem && (
        <Banner kind="error" title="Your settings file has a mistake">
          <p>{vpn.configProblem}</p>
          <p>Until it is fixed, Homeport behaves as if a VPN is required.</p>
        </Banner>
      )}

      {vpn.configured && !editing ? (
        <>
          <Banner kind="ok" title="VPN settings saved">
            <p>
              {providerLabel(vpn.provider)} ({vpn.type ?? "default"}). Homeport will test the connection
              during the install and start downloads only if it works.
            </p>
          </Banner>
          <div className="row">
            <Button onClick={() => setEditing(true)}>Change</Button>
            <Button
              variant="quiet"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  onChange(await api.clearVpn());
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </Button>
          </div>
        </>
      ) : (
        <VpnForm
          onSaved={(v) => {
            setEditing(false);
            onChange(v);
          }}
        />
      )}

      <details style={{ marginTop: "1.25rem" }}>
        <summary>I have decided to download without a VPN</summary>
        <p style={{ marginTop: "0.75rem" }}>
          Homeport will not do this for you, on purpose. If you understand the risk and still want it, you can
          change one line in a settings file by hand:
        </p>
        <ol>
          <li>
            Open a terminal and run: <code>docker exec -it homeport vi {configFile}</code>
          </li>
          <li>
            Change <code>allow_unprotected = false</code> to <code>true</code>, save, and quit.
          </li>
          <li>
            Restart Homeport: <code>docker restart homeport</code>
          </li>
        </ol>
      </details>
    </div>
  );
}

export function PlanScreen({
  settings,
  advanced,
  onSettings,
  onBack,
  onNext,
}: {
  settings: Settings;
  advanced: boolean;
  onSettings: (s: Settings) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [vpn, setVpn] = useState<VpnView | null>(null);
  const [file, setFile] = useState("/data/homeport.toml");
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState<string | null>(null);
  const [form, setForm] = useState({
    project: settings.project,
    timezone: settings.timezone,
    puid: String(settings.puid),
    pgid: String(settings.pgid),
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, v, c] = await Promise.all([api.plan(), api.vpn(), api.config()]);
      setPlan(p);
      setVpn(v);
      setFile(c.file);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const refreshPlan = async (v: VpnView) => {
    setVpn(v);
    setPlan(await api.plan());
  };

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      if (advanced) {
        onSettings(
          await api.saveSettings({
            project: form.project,
            timezone: form.timezone,
            puid: Number(form.puid),
            pgid: Number(form.pgid),
          }),
        );
      }
      onNext();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!plan || !vpn)
    return error ? (
      <div className="narrow">
        <Banner kind="error">{error}</Banner>
        <Button onClick={onBack}>Back</Button>
      </div>
    ) : (
      <p className="center">
        <Spinner label="Loading" /> Preparing your plan…
      </p>
    );

  return (
    <div className="narrow stack">
      <div>
        <h1>Here's the plan</h1>
        <p className="muted">
          This is what Homeport will install and connect for you. It needs about{" "}
          {(plan.ramMB / 1024).toFixed(1)} GB of memory to run comfortably.
        </p>
      </div>

      <div className="card">
        <h2>What you'll get</h2>
        <ul className="list">
          {plan.services.map((s) => (
            <li key={s.id}>
              <div className="grow">
                <strong>{s.name}</strong>
                <div className="muted">{s.purpose}</div>
              </div>
              {plan.vpn.hold.includes(s.id) || (plan.vpn.vpn && s.id === "qbittorrent") ? (
                <Badge kind="warn">Needs a VPN</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {(vpn.needed || vpn.unprotected) && <VpnSection vpn={vpn} onChange={refreshPlan} configFile={file} />}

      {advanced && (
        <div className="card">
          <h2>Advanced settings</h2>
          <div className="grid">
            <Field label="Project name" hint="Used to name the containers and volumes.">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  value={form.project}
                  onChange={(e) => setForm({ ...form, project: e.target.value })}
                />
              )}
            </Field>
            <Field label="Time zone">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                />
              )}
            </Field>
            <Field label="User ID (PUID)" hint="Who owns the files the apps create.">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  value={form.puid}
                  onChange={(e) => setForm({ ...form, puid: e.target.value })}
                />
              )}
            </Field>
            <Field label="Group ID (PGID)">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  value={form.pgid}
                  onChange={(e) => setForm({ ...form, pgid: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="row">
            <Button
              onClick={async () => {
                try {
                  setCompose(await api.composeText());
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              Show the Compose file
            </Button>
            <a className="btn" href="/api/compose" download="compose.yaml">
              Download it
            </a>
          </div>
          {compose && <pre className="log">{compose}</pre>}
        </div>
      )}

      {error && <Banner kind="error">{error}</Banner>}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" big busy={busy} onClick={next}>
          Continue
        </Button>
      </div>
    </div>
  );
}
