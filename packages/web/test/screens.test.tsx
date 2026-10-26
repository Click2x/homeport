// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VpnForm } from "../src/components/VpnForm";
import { SetupScreen } from "../src/screens/Auth";
import { GoalsScreen } from "../src/screens/Goals";
import { stepStates } from "../src/screens/Install";
import type { Goal, JobEvent, Settings } from "../src/types";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];

/** A fake fetch: records every call and answers from a table of `METHOD /path` -> [status, body]. */
function fakeApi(routes: Record<string, [number, unknown]>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });
      const [status, payload] = routes[`${method} ${url}`] ?? [404, { error: "not found" }];
      return new Response(JSON.stringify(payload), { status });
    }),
  );
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(cleanup);

const goal: Goal = {
  id: "watch",
  title: "Watch movies and shows",
  description: "Collect movies and TV.",
  apps: [{ id: "jellyfin", name: "Jellyfin", purpose: "Streaming", needsVpn: false }],
};
const settings: Settings = {
  goals: [],
  project: "homeport",
  hostPorts: {},
  data: { mode: "volume" },
  timezone: "UTC",
  puid: 1000,
  pgid: 1000,
  apps: [],
};

describe("SetupScreen", () => {
  it("labels every field, so a screen reader can announce them", () => {
    fakeApi({});
    render(<SetupScreen onDone={() => {}} />);
    expect(screen.getByLabelText("Setup code")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose a username")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose a password")).toBeInTheDocument();
  });

  it("sends the code and account details with the anti-forgery header, then continues", async () => {
    fakeApi({ "POST /api/setup": [200, { ok: true }] });
    const done = vi.fn();
    render(<SetupScreen onDone={done} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Setup code"), "abcd-efgh-jkmn");
    await user.type(screen.getByLabelText("Choose a password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/api/setup",
      body: { token: "abcd-efgh-jkmn", username: "admin", password: "correct horse battery" },
    });
    expect(calls[0]?.headers["X-Homeport"]).toBe("1");
  });

  it("shows the server's plain-language reason when it is refused", async () => {
    fakeApi({
      "POST /api/setup": [
        403,
        { error: "That setup code is not right. Copy it from the Homeport log again." },
      ],
    });
    render(<SetupScreen onDone={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Setup code"), "nope");
    await user.type(screen.getByLabelText("Choose a password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code is not right");
  });
});

describe("GoalsScreen", () => {
  it("cannot continue until something is chosen, then saves the choice", async () => {
    fakeApi({ "PUT /api/settings": [200, { ...settings, goals: ["watch"], apps: ["jellyfin"] }] });
    const saved = vi.fn();
    render(<GoalsScreen goals={[goal]} settings={settings} onSaved={saved} />);
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next).toBeDisabled();
    const user = userEvent.setup();
    const choice = screen.getByRole("button", { name: /Watch movies and shows/ });
    expect(choice).toHaveAttribute("aria-pressed", "false");
    await user.click(choice);
    expect(choice).toHaveAttribute("aria-pressed", "true");
    await user.click(next);
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({ goals: ["watch"] });
  });
});

describe("VpnForm", () => {
  const view = {
    configured: true,
    verified: false,
    provider: "protonvpn",
    type: "wireguard",
    filled: [],
    needed: true,
    unprotected: false,
    downloadsOnHold: true,
    message: null,
    configProblem: null,
  };

  it("sends only the key and address from a pasted WireGuard file", async () => {
    fakeApi({ "PUT /api/vpn": [200, view] });
    const saved = vi.fn();
    render(<VpnForm onSaved={saved} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Paste your WireGuard file"));
    await user.paste(
      "[Interface]\nPrivateKey = KEYKEYKEY=\nAddress = 10.2.0.2/32\n\n[Peer]\nPublicKey = P=\nEndpoint = 203.0.113.9:51820\n",
    );
    expect(await screen.findByText(/Found your key and address/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save VPN settings" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({
      values: {
        VPN_SERVICE_PROVIDER: "protonvpn",
        VPN_TYPE: "wireguard",
        WIREGUARD_PRIVATE_KEY: "KEYKEYKEY=",
        WIREGUARD_ADDRESSES: "10.2.0.2/32",
      },
    });
  });

  it("refuses to save without a file, and says what to do", async () => {
    fakeApi({});
    render(<VpnForm onSaved={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save VPN settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Paste the WireGuard file/);
    expect(calls).toHaveLength(0);
  });

  it("explains a file that is not quite right instead of saving it", async () => {
    fakeApi({});
    render(<VpnForm onSaved={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Paste your WireGuard file"));
    await user.paste("[Interface]\nAddress = 10.2.0.2/32\n");
    expect(await screen.findByText(/no private key/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save VPN settings" }));
    expect(calls).toHaveLength(0);
  });
});

describe("stepStates", () => {
  const ev = (seq: number, step: string, status: JobEvent["status"]): JobEvent => ({
    seq,
    at: "",
    step,
    status,
    message: "",
  });
  it("shows the latest state of each step", () => {
    const s = stepStates([ev(1, "docker", "running"), ev(2, "docker", "done"), ev(3, "pull", "running")]);
    expect(s).toEqual({ docker: "done", pull: "running" });
  });
  it("keeps a warning visible even after the step finishes", () => {
    const s = stepStates([ev(1, "storage", "running"), ev(2, "storage", "warn"), ev(3, "storage", "done")]);
    expect(s).toEqual({ storage: "warn" });
  });
  it("ignores informational lines", () => {
    expect(stepStates([ev(1, "wire", "info")])).toEqual({});
  });
});
