import { useMemo, useState } from "react";
import { api } from "../api";
import type { VpnView } from "../types";
import { PROVIDERS, parseWireguardConf } from "../vpn";
import { Banner, Button, errorText, Field } from "./ui";

/** Collects the VPN account details. Secrets are sent to Homeport and never shown again. */
export function VpnForm({ onSaved }: { onSaved: (v: VpnView) => void }) {
  const [providerId, setProviderId] = useState("protonvpn");
  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];
  const [type, setType] = useState<"wireguard" | "openvpn">("wireguard");
  const effectiveType = provider?.types.includes(type) ? type : (provider?.types[0] ?? "wireguard");
  const [conf, setConf] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [countries, setCountries] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustom = providerId === "custom";
  const parsed = useMemo(
    () => (conf.trim() ? parseWireguardConf(conf, { needsPeer: isCustom }) : null),
    [conf, isCustom],
  );

  const save = async () => {
    setError(null);
    const values: Record<string, string> = { VPN_SERVICE_PROVIDER: providerId, VPN_TYPE: effectiveType };
    if (effectiveType === "wireguard") {
      if (!parsed || parsed.problems.length) {
        setError(parsed?.problems[0] ?? "Paste the WireGuard file your VPN provider gave you.");
        return;
      }
      Object.assign(values, parsed.values);
    } else {
      if (!user.trim() || !pass) {
        setError("Enter your VPN username and password.");
        return;
      }
      values.OPENVPN_USER = user.trim();
      values.OPENVPN_PASSWORD = pass;
    }
    if (countries.trim()) values.SERVER_COUNTRIES = countries.trim();
    setBusy(true);
    try {
      onSaved(await api.saveVpn(values));
      setConf("");
      setPass("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: "14rem" }}>
          <Field label="Who is your VPN provider?">
            {(id) => (
              <select id={id} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {provider && provider.types.length > 1 && (
          <div style={{ flex: 1, minWidth: "14rem" }}>
            <Field
              label="Connection type"
              hint="WireGuard is faster and simpler when your provider offers it."
            >
              {(id) => (
                <select
                  id={id}
                  value={effectiveType}
                  onChange={(e) => setType(e.target.value as "wireguard" | "openvpn")}
                >
                  {provider.types.map((t) => (
                    <option key={t} value={t}>
                      {t === "wireguard" ? "WireGuard" : "OpenVPN"}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
      </div>

      {effectiveType === "wireguard" ? (
        <>
          <Field
            label="Paste your WireGuard file"
            hint="In your VPN account, create a WireGuard configuration and download it. Open the file in a text editor, copy everything and paste it here. Homeport reads the key and address from it and never shows them again."
          >
            {(id) => (
              <textarea
                id={id}
                rows={7}
                spellCheck={false}
                autoComplete="off"
                value={conf}
                onChange={(e) => setConf(e.target.value)}
                placeholder={"[Interface]\nPrivateKey = …\nAddress = …\n"}
                style={{ fontFamily: "var(--mono)" }}
              />
            )}
          </Field>
          {parsed &&
            (parsed.problems.length ? (
              <Banner kind="warn" title="This file is not quite right">
                {parsed.problems.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </Banner>
            ) : (
              <Banner kind="ok">
                <p>Found your key and address. Ready to save.</p>
              </Banner>
            ))}
        </>
      ) : (
        <>
          <Field
            label="VPN username"
            hint="Some providers use a separate username for OpenVPN. Check the OpenVPN section of your account."
          >
            {(id) => (
              <input
                id={id}
                type="text"
                autoComplete="off"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            )}
          </Field>
          <Field label="VPN password">
            {(id) => (
              <input
                id={id}
                type="password"
                autoComplete="off"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            )}
          </Field>
        </>
      )}

      {!isCustom && (
        <Field
          label="Preferred country (optional)"
          hint="For example: Netherlands. Leave empty to let the provider choose."
        >
          {(id) => (
            <input id={id} type="text" value={countries} onChange={(e) => setCountries(e.target.value)} />
          )}
        </Field>
      )}

      {error && <Banner kind="error">{error}</Banner>}
      <Button variant="primary" busy={busy} onClick={save}>
        Save VPN settings
      </Button>
    </div>
  );
}
