import type { ReactNode } from "react";

type Tone = "pos" | "warn" | "neg" | "neutral" | "stage";
const TONES: Record<Tone, string> = {
  pos: "bg-positive-fill text-positive",
  warn: "bg-warning-fill text-warning",
  neg: "bg-negative-fill text-[#b91c1c]",
  neutral: "bg-rule text-text-secondary",
  stage: "bg-ink text-accent",
};

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-[5px] px-2 py-[3px] text-[11px] font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}
