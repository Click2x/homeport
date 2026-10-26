import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useId, useState } from "react";

export function Button({
  variant = "default",
  big,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "quiet";
  big?: boolean;
  busy?: boolean;
}) {
  const cls = ["btn", variant === "default" ? "" : variant, big ? "big" : ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest} disabled={rest.disabled || busy}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <>
      <span className="spinner" aria-hidden="true" />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

const ICONS = { info: "i", ok: "✓", warn: "!", error: "✕" } as const;

/** A message with a coloured edge and an icon, so meaning never depends on colour alone. */
export function Banner({
  kind = "info",
  title,
  children,
}: {
  kind?: keyof typeof ICONS;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="icon" aria-hidden="true">
        {ICONS[kind]}
      </span>
      <div>
        {title && (
          <p>
            <strong>{title}</strong>
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** A labelled input. The label wraps the control, so they are always connected for screen readers. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <span className="label">{label}</span>
      </label>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Badge({ kind, children }: { kind?: "ok" | "warn" | "error"; children: ReactNode }) {
  return (
    <span className={`badge ${kind ?? ""}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Steps({ current, labels }: { current: number; labels: string[] }) {
  return (
    <ol className="steps" aria-label="Setup progress">
      {labels.map((label, i) => (
        <li
          key={label}
          className={i < current ? "done" : ""}
          aria-current={i === current ? "step" : undefined}
        >
          <span className="num" aria-hidden="true">
            {i < current ? "✓" : i + 1}
          </span>
          <span className="text">{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** Copies text to the clipboard and says so, for secrets people have to type into another app. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn quiet"
      style={{ minHeight: "32px", padding: "0.15rem 0.6rem" }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          // Clipboard blocked (for example on plain http): the text is still on screen to copy by hand.
        }
      }}
    >
      {done ? "Copied" : "Copy"}
      <span className="sr-only"> {label}</span>
    </button>
  );
}
