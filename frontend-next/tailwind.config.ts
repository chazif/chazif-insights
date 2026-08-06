import type { Config } from "tailwindcss";

// Colours mirror docs/design-handoff/tokens.ts (sampled from the live app).
// Rules (see the handoff README): `accent` (lime) is INTERACTIVE ONLY — never text
// on a light surface, never a fill on a light surface, never behind white text.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        rail: "#1f2937",
        accent: "#cfff04",
        ink: "#1a1a1a",
        surface: "#ffffff",
        "surface-alt": "#f9fafb",
        rule: "#f3f4f6",
        border: "#e5e7eb",
        "border-strong": "#d1d5db",
        "text-secondary": "#374151",
        "text-tertiary": "#4b5563",
        "text-muted": "#6b7280",
        "text-disabled": "#9ca3af",
        "strip-bg": "#fafaf7",
        "strip-border": "#e6e6e0",
        positive: "#15803d",
        "positive-fill": "#dcfce7",
        warning: "#b45309",
        "warning-fill": "#fef9c3",
        negative: "#dc2626",
        "negative-fill": "#fee2e2",
        attention: "#d97706",
        "row-hover": "#fdfff5",
      },
      fontFamily: {
        ui: ["'Instrument Sans'", "system-ui", "sans-serif"],
        display: ["'Instrument Serif'", "serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
