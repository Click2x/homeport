// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneUrl, RemoteScreen } from "../src/screens/Remote";
import type { Invite, Person, RemoteView } from "../src/types";

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[] = [];

function fakeApi(routes: Record<string, [number, unknown] | (() => [number, unknown])>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[`${method} ${url}`];
      const [status, payload] = (typeof route === "function" ? route() : route) ?? [
        404,
        { error: "not found" },
      ];
      return new Response(JSON.stringify(payload), { status });
    }),
  );
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(cleanup);

const shareable = [
  { id: "jellyfin", name: "Jellyfin", port: 8096, sensitive: false },
  { id: "seerr", name: "Seerr", port: 5055, sensitive: false },
  { id: "sonarr", name: "Sonarr", port: 8989, sensitive: true },
];
const sam: Person = {
  id: "p1",
  name: "Sam",
  ip: "10.13.13.2",
  services: ["jellyfin"],
  createdAt: "2026-10-26T00:00:00Z",
  expiresAt: null,
  online: false,
  lastSeen: null,
};
const base: RemoteView = {
  enabled: false,
  endpoint: "",
  endpointProblem: null,
  port: 51820,
  live: false,
  needsApply: false,
  gatewayAddress: "10.13.13.1",
  people: [],
  shareable,
};
const on = (over: Partial<RemoteView> = {}): RemoteView => ({
  ...base,
  enabled: true,
  endpoint: "home.example.com",
  live: true,
  ...over,
});

describe("turning remote access on", () => {
  it("explains what is needed before asking for anything", async () => {
    fakeApi({ "GET /api/remote": [200, base] });
    render(<RemoteScreen onApply={() => {}} />);
    expect(await screen.findByText(/forward/i)).toBeInTheDocument();
    expect(screen.getByLabelText("What will people connect to?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on remote access" })).toBeInTheDocument();
  });

  it("fills in the public address when asked", async () => {
    fakeApi({ "GET /api/remote": [200, base], "POST /api/remote/detect": [200, { ip: "203.0.113.9" }] });
    render(<RemoteScreen onApply={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Find my address" }));
    await waitFor(() =>
      expect(screen.getByLabelText("What will people connect to?")).toHaveValue("203.0.113.9"),
    );
  });

  it("shows the server's plain reason when the address cannot work", async () => {
    fakeApi({
      "GET /api/remote": [200, base],
      "PUT /api/remote": [400, { error: "That is a private address that only works inside your home." }],
    });
    render(<RemoteScreen onApply={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("What will people connect to?"), "192.168.1.5");
    await user.click(screen.getByRole("button", { name: "Turn on remote access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("private address");
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({
      enabled: true,
      endpoint: "192.168.1.5",
    });
  });
});

describe("when it is on", () => {
  it("tells people to apply their changes before it works, and offers the button", async () => {
    fakeApi({ "GET /api/remote": [200, on({ live: false, needsApply: true })] });
    const apply = vi.fn();
    render(<RemoteScreen onApply={apply} />);
    expect(await screen.findByText(/One more step/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply now" }));
    expect(apply).toHaveBeenCalled();
  });

  it("tells them exactly which router setting to change", async () => {
    fakeApi({ "GET /api/remote": [200, on({ port: 51999 })] });
    render(<RemoteScreen onApply={() => {}} />);
    expect(await screen.findByText(/UDP port 51999/)).toBeInTheDocument();
  });

  it("lists people with whether they are connected and what they may open", async () => {
    fakeApi({
      "GET /api/remote": [
        200,
        on({
          people: [sam, { ...sam, id: "p2", name: "Alex", online: true, services: ["jellyfin", "seerr"] }],
        }),
      ],
    });
    render(<RemoteScreen onApply={() => {}} />);
    expect(await screen.findByText("Never connected")).toBeInTheDocument();
    expect(screen.getByText("Connected now")).toBeInTheDocument();
    expect(screen.getByText("Can open: Jellyfin, Seerr")).toBeInTheDocument();
  });

  it("removes someone only after confirming, and says it is immediate", async () => {
    fakeApi({
      "GET /api/remote": [200, on({ people: [sam] })],
      "DELETE /api/remote/people/p1": [200, { applied: true }],
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<RemoteScreen onApply={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Remove" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("stop working straight away"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("does not remove anyone when they cancel", async () => {
    fakeApi({ "GET /api/remote": [200, on({ people: [sam] })] });
    vi.stubGlobal("confirm", () => false);
    render(<RemoteScreen onApply={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Remove" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("inviting someone", () => {
  it("pre-selects the friendly apps and labels admin tools as risky", async () => {
    fakeApi({ "GET /api/remote": [200, on()] });
    render(<RemoteScreen onApply={() => {}} />);
    const jelly = await screen.findByRole("checkbox", { name: /^Jellyfin/ });
    expect(jelly).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Seerr/ })).toBeChecked();
    const sonarr = screen.getByRole("checkbox", { name: /^Sonarr/ });
    expect(sonarr).not.toBeChecked();
    expect(sonarr.closest("label")).toHaveTextContent(/admin tool/);
  });

  const invite: Invite = {
    person: sam,
    config: "[Interface]\nPrivateKey = SECRETSECRET=\n",
    qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    applied: true,
    note: "Ready.",
  };

  it("shows the code once, with how to use it and a warning that it will not be shown again", async () => {
    fakeApi({
      "GET /api/remote": [200, on()],
      "POST /api/remote/people": [201, invite],
    });
    render(<RemoteScreen onApply={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Who is it for?"), "Sam");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByText(/only time you will see this code/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /QR code to add Sam/ })).toBeInTheDocument();
    expect(screen.getByText("http://10.13.13.1:8096")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      name: "Sam",
      services: ["jellyfin", "seerr"],
    });
  });

  it("renders the QR as an image, never as markup that could run script", async () => {
    fakeApi({
      "GET /api/remote": [200, on()],
      "POST /api/remote/people": [
        201,
        { ...invite, qr: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
      ],
    });
    const { container } = render(<RemoteScreen onApply={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Who is it for?"), "Sam");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    await screen.findByRole("img", { name: /QR code/ });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  });

  it("hides the private key until asked, and goes back to the list when done", async () => {
    fakeApi({ "GET /api/remote": [200, on()], "POST /api/remote/people": [201, invite] });
    render(<RemoteScreen onApply={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Who is it for?"), "Sam");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    await screen.findByRole("img", { name: /QR code/ });
    expect(screen.queryByText(/SECRETSECRET/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the text" }));
    expect(screen.getByText(/SECRETSECRET/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I have set it up" }));
    expect(await screen.findByText("Invite someone")).toBeInTheDocument();
    expect(screen.queryByText(/SECRETSECRET/)).toBeNull();
  });

  it("says why an invitation was refused", async () => {
    fakeApi({
      "GET /api/remote": [200, on()],
      "POST /api/remote/people": [
        400,
        { error: "You already invited someone called Sam. Choose a different name." },
      ],
    });
    render(<RemoteScreen onApply={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Who is it for?"), "Sam");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already invited");
  });
});

describe("phoneUrl", () => {
  it("points at the gateway address and the app's own port", () => {
    expect(phoneUrl("10.13.13.1", { id: "jellyfin", name: "Jellyfin", port: 8096, sensitive: false })).toBe(
      "http://10.13.13.1:8096",
    );
  });
});

export { within };
