import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { Banner, Button, errorText, Spinner, Steps } from "./components/ui";
import { AccountScreen } from "./screens/Account";
import { LoginScreen, SetupScreen } from "./screens/Auth";
import { DashboardScreen } from "./screens/Dashboard";
import { GoalsScreen } from "./screens/Goals";
import { InstallScreen } from "./screens/Install";
import { PlanScreen } from "./screens/Plan";
import { RemoteScreen } from "./screens/Remote";
import { StorageScreen } from "./screens/Storage";
import type { Goal, Settings, StackView, Status, SystemView } from "./types";

type Route = "goals" | "plan" | "storage" | "install" | "dashboard" | "remote" | "account";
const WIZARD: Route[] = ["goals", "plan", "storage", "install"];
const WIZARD_LABELS = ["Choose", "Plan", "Storage", "Install"];
const ROUTES: Route[] = [...WIZARD, "dashboard", "remote", "account"];

function routeFromHash(): Route | null {
  const r = window.location.hash.replace(/^#\/?/, "") as Route;
  return ROUTES.includes(r) ? r : null;
}

function readAdvanced(): boolean {
  try {
    return localStorage.getItem("homeport.advanced") === "1";
  } catch {
    return false;
  }
}

interface Data {
  goals: Goal[];
  settings: Settings;
  stack: StackView;
  system: SystemView;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [route, setRoute] = useState<Route | null>(routeFromHash());
  const [advanced, setAdvanced] = useState(readAdvanced);
  const [error, setError] = useState<string | null>(null);

  const go = useCallback((r: Route) => {
    window.location.hash = `#/${r}`;
    setRoute(r);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    setUnauthorizedHandler(() => {
      setData(null);
      setStatus((s) => (s ? { ...s, authenticated: false } : s));
    });
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      if (s.authenticated) {
        const [catalog, settings, stack, system] = await Promise.all([
          api.catalog(),
          api.settings(),
          api.stack(),
          api.system(),
        ]);
        setData({ goals: catalog.goals, settings, stack, system });
        setRoute((current) => current ?? (stack.deployed ? "dashboard" : "goals"));
      }
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggleAdvanced = (on: boolean) => {
    setAdvanced(on);
    try {
      localStorage.setItem("homeport.advanced", on ? "1" : "0");
    } catch {
      // Private browsing: the choice just lasts until the page closes.
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setData(null);
    setRoute(null);
    window.location.hash = "";
    await load();
  };

  let body: React.ReactNode;
  if (error && !status) {
    body = (
      <div className="narrow stack center">
        <Banner kind="error" title="Homeport could not be reached">
          <p>{error}</p>
        </Banner>
        <div>
          <Button variant="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (!status) {
    body = (
      <p className="center">
        <Spinner label="Loading" /> Starting up…
      </p>
    );
  } else if (status.setupRequired) {
    body = <SetupScreen onDone={() => void load()} />;
  } else if (!status.authenticated) {
    body = <LoginScreen onDone={() => void load()} />;
  } else if (!data) {
    body = (
      <p className="center">
        <Spinner label="Loading" /> Loading…
      </p>
    );
  } else {
    const current = route ?? (data.stack.deployed ? "dashboard" : "goals");
    const wizardIndex = WIZARD.indexOf(current);
    const setSettings = (settings: Settings) => setData((d) => (d ? { ...d, settings } : d));
    body = (
      <>
        {!data.system.docker.ok && (
          <Banner kind="error" title="Docker is not ready">
            <p>{data.system.docker.problem}</p>
          </Banner>
        )}
        {wizardIndex >= 0 && <Steps current={wizardIndex} labels={WIZARD_LABELS} />}
        {current === "goals" && (
          <GoalsScreen
            goals={data.goals}
            settings={data.settings}
            onSaved={(s) => {
              setSettings(s);
              go("plan");
            }}
          />
        )}
        {current === "plan" && (
          <PlanScreen
            settings={data.settings}
            advanced={advanced}
            onSettings={setSettings}
            onBack={() => go("goals")}
            onNext={() => go("storage")}
          />
        )}
        {current === "storage" && (
          <StorageScreen
            settings={data.settings}
            onSettings={setSettings}
            onBack={() => go("plan")}
            onNext={() => go("install")}
          />
        )}
        {current === "install" && (
          <InstallScreen
            deployedBefore={Boolean(data.stack.deployed)}
            onBack={() => go("storage")}
            onDone={async () => {
              await load();
              go("dashboard");
            }}
          />
        )}
        {current === "dashboard" && (
          <DashboardScreen
            goals={data.goals}
            settings={data.settings}
            onChangeSetup={() => go("goals")}
            onApply={() => go("install")}
            onFixVpn={() => go("plan")}
          />
        )}
        {current === "remote" && <RemoteScreen onApply={() => go("install")} />}
        {current === "account" && <AccountScreen username={status.username ?? ""} />}
      </>
    );
  }

  const signedIn = Boolean(status?.authenticated && data);
  const active = route ?? (data?.stack.deployed ? "dashboard" : "goals");
  return (
    <>
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <header className="header">
        <div className="header-inner">
          <a className="brand" href="#/dashboard">
            <span className="brand-mark" aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <title>Anchor</title>
                <circle cx="12" cy="5" r="2.5" />
                <path d="M12 7.5V21M5 13c0 4 3 8 7 8s7-4 7-8M3 13h4M17 13h4" />
              </svg>
            </span>
            Homeport
          </a>
          {signedIn && (
            <>
              <nav className="nav" aria-label="Main">
                <a href="#/dashboard" aria-current={active === "dashboard" ? "page" : undefined}>
                  Dashboard
                </a>
                <a href="#/goals" aria-current={WIZARD.includes(active) ? "page" : undefined}>
                  Set up
                </a>
                <a href="#/remote" aria-current={active === "remote" ? "page" : undefined}>
                  Remote access
                </a>
                <a href="#/account" aria-current={active === "account" ? "page" : undefined}>
                  Account
                </a>
              </nav>
              <span className="spacer" />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={advanced}
                  onChange={(e) => toggleAdvanced(e.target.checked)}
                />
                Advanced
              </label>
              <button type="button" className="btn quiet" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <main id="main">{body}</main>
      <footer className="footer">
        Homeport {data?.system.version ?? ""} · open source (AGPL-3.0) ·{" "}
        <a href="https://github.com/Click2x/homeport" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </footer>
    </>
  );
}
