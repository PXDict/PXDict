// Small form building blocks shared by the screens.
import type { ComponentChildren } from "preact";

export interface FieldProps {
  label: string;
  name: string;
  type?: "text" | "password" | "email";
  value: string;
  onInput: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  inputMode?: "text" | "numeric" | "email";
  autoFocus?: boolean;
  hint?: string;
}

export function Field(p: FieldProps) {
  const id = `f-${p.name}`;
  const common = {
    id,
    name: p.name,
    value: p.value,
    onInput: (e: { currentTarget: HTMLInputElement }) => {
      p.onInput(e.currentTarget.value);
    },
    autocomplete: p.autoComplete,
    required: p.required,
    minLength: p.minLength,
    autoFocus: p.autoFocus,
    autocapitalize: "off" as const,
    spellcheck: false,
  };
  // Preact's typings discriminate <input> on `type`, so each type is spelled out.
  const input =
    p.type === "password" ? (
      <input type="password" {...common} />
    ) : p.type === "email" ? (
      <input type="email" inputMode="email" {...common} />
    ) : (
      <input type="text" inputMode={p.inputMode} {...common} />
    );
  return (
    <label class="field" for={id}>
      <span>{p.label}</span>
      {input}
      {p.hint && <small class="hint">{p.hint}</small>}
    </label>
  );
}

/** A message area announced to screen readers. */
export function Notice({ kind, children }: { kind: "error" | "info"; children: ComponentChildren }) {
  return (
    <p class={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}
