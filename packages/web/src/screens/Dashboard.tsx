import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Banner, Button, CopyButton, errorText, Spinner } from "../components/ui";
import type { Credentials, Goal, Settings, StackView, StorageReport, VpnReport, VpnView } from "../types";
import { providerLabel } from "../vpn";
import { TIER_TEXT } from "./Storage";

const FRIENDLY_FIRST = ["jellyfin", "seerr"];
const OPEN_LABEL: Record<string, string> = { jellyfin: "Watch", seerr: "Request something" };

function linkFor(port: number | undefined) {
  return port ? `${window.location.protocol}//${window.location.hostname}:${port}` : null;
}

export function DashboardScreen({
  goals,
  settings,
  onChangeSetup,
  onApply,
  onFixVpn,
}: {
  goals: Goal[];
  settings: Settings;
  onChangeSetup: () => void;
  onApply: () => void;
  onFixVpn: () => void;
}) {
  const [stack, setStack] = useState<StackView | null>(null);
  const [vpn, setVpn] = useState<VpnView | null>(null);
  const [vpnReport, setVpnReport] = useState<VpnReport | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([api.stack(), api.vpn()]);
      setStack(s);
      setVpn(v);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!stack || !vpn)
    return (
      <p className="center">
        <Spinner label="Loading" /> Loading your dashboard…
      </p>
    );

  const info = new Map(goals.flatMap((g) => g.apps).map((a) => [a.id, a]));
  const result = stack.deployed?.result;
  const held = new Set(result?.held ?? []);
  const states = new Map(stack.containers.map((c) => [c.service, c]));
  const ids = [...new Set([...FRIENDLY_FIRST, ...settings.apps])].filter(
    (id) => info.has(id) && id !== "gluetun",
  );
  const ordered = [...ids].sort(
    (a, b) => Number(FRIENDLY_FIRST.includes(b)) - Number(FRIENDLY_FIRST.includes(a)),
  );

  if (!stack.deployed)
    return (
      <div className="narrow stack center">
        <h1>Nothing is installed yet</h1>
        <p className="muted">Choose what you want to do and Homeport will set it up.</p>
        <div>
          <Button variant="primary" big onClick={onChangeSetup}>
            Get started
          </Button>
        </div>
      </div>
    );

  const downloadsOn = held.size === 0;
  return (
    <div className="stack">
      <div>
        <h1>Your home server</h1>
        <p className="muted">Everything Homeport set up for you, in one place.</p>
      </div>

      {downloadsOn ? (
        <Banner kind="ok" title="Everything is running">
          <p>Downloads are on and protected by your VPN.</p>
        </Banner>
      ) : (
        <Banner kind="warn" title="Downloads are on hold">
          <p>{vpn.message ?? "Your VPN is not confirmed working yet."} Everything else is ready to use.</p>
          <div className="row">
            <Button onClick={onFixVpn}>{vpn.configured ? "Review VPN settings" : "Add my VPN"}</Button>
            {vpn.configured && (
              <Button variant="primary" onClick={onApply}>
                Try again
              </Button>
            )}
          </div>
        </Banner>
      )}
      {vpn.unprotected && (
        <Banner kind="warn" title="Running without a VPN">
          <p>
            Your settings file turned the VPN requirement off. Your home address is visible to people you
            share files with.
          </p>
        </Banner>
      )}
      {error && <Banner kind="error">{error}</Banner>}

      <div className="grid">
        {ordered.map((id) => {
          const app = info.get(id);
          if (!app) return null;
          const c = states.get(id);
          const onHold = held.has(id);
          const running = c?.state === "running";
          const url = linkFor(result?.ports[id]?.web);
          const primary = FRIENDLY_FIRST.includes(id);
          return (
            <div key={id} className="card service">
              <div className="top">
                <h2>{app.name}</h2>
                {onHold ? (
                  <Badge kind="warn">On hold</Badge>
                ) : running ? (
                  <Badge kind="ok">{c?.health === "unhealthy" ? "Starting" : "Running"}</Badge>
                ) : (
                  <Badge kind="error">Stopped</Badge>
                )}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {app.purpose}
              </p>
              {onHold && <p style={{ margin: 0 }}>Waiting for a working VPN.</p>}
              {url && running && !onHold && (
                <div>
                  <a
                    className={`btn ${primary ? "primary" : ""}`}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {OPEN_LABEL[id] ?? "Open"}
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid">
        <div className="card">
          <h2>Your VPN</h2>
          {vpn.unprotected ? (
            <p>Turned off in your settings file.</p>
          ) : vpn.configured ? (
            <p>
              {providerLabel(vpn.provider)} ({vpn.type ?? "default"}) —{" "}
              {vpn.verified ? "working" : "not confirmed yet"}.
            </p>
          ) : (
            <p>No VPN is set up.</p>
          )}
          {vpnReport && (
            <ul className="list">
              {vpnReport.checks.map((c) => (
                <li key={c.id}>
                  <Badge kind={c.status === "pass" ? "ok" : "error"}>
                    {c.status === "pass" ? "OK" : "Problem"}
                  </Badge>
                  <span className="grow">{c.summary}</span>
                </li>
              ))}
            </ul>
          )}
          <Button
            busy={busy === "vpn"}
            onClick={() => run("vpn", async () => setVpnReport(await api.checkVpn()))}
            disabled={!vpn.configured || vpn.unprotected}
          >
            Test it now
          </Button>
        </div>

        <div className="card">
          <h2>Your library's home</h2>
          {(() => {
            const t = storage ? TIER_TEXT[storage.tier] : TIER_TEXT[result?.storage.tier ?? "good"];
            return (
              <>
                <p>
                  <Badge kind={t.kind}>{t.label}</Badge>
                </p>
                <p>{t.text}</p>
              </>
            );
          })()}
          {storage?.results
            .filter((r) => r.status !== "pass")
            .map((r) => (
              <p key={r.id} className="muted">
                {r.summary}
              </p>
            ))}
          <Button
            busy={busy === "storage"}
            onClick={() => run("storage", async () => setStorage(await api.checkStorage()))}
          >
            Check again
          </Button>
        </div>

        <div className="card">
          <h2>Sign-in details</h2>
          <p className="muted">
            You'll need these the first time you open Jellyfin or the download client. Keep them somewhere
            safe.
          </p>
          {creds ? (
            <div className="stack">
              {(
                [
                  ["Jellyfin and Seerr", creds.jellyfin],
                  ["Download client", creds.qbittorrent],
                ] as const
              ).map(([title, c]) => (
                <div key={title}>
                  <b>{title}</b>
                  <div className="row mono" style={{ gap: "0.4rem" }}>
                    <span>{c.user}</span>
                    <CopyButton text={c.user} label={`${title} username`} />
                  </div>
                  <div className="row mono" style={{ gap: "0.4rem", wordBreak: "break-all" }}>
                    <span>{c.password ?? "—"}</span>
                    {c.password && <CopyButton text={c.password} label={`${title} password`} />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Button
              busy={busy === "creds"}
              onClick={() => run("creds", async () => setCreds(await api.credentials()))}
            >
              Show them
            </Button>
          )}
        </div>
      </div>

      <div className="row">
        <Button onClick={onApply}>Update or repair</Button>
        <Button onClick={onChangeSetup}>Change what's installed</Button>
        <a className="btn" href="/api/compose" download="compose.yaml">
          Download the Compose file
        </a>
      </div>
    </div>
  );
}
