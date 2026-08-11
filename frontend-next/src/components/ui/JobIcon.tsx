import type { JobKey } from "../../nav/model";

// Single-path line icons from the design handoff (viewBox 0 0 24 24, single-weight).
const PATHS: Record<JobKey, string> = {
  today: "M5 4h14v16H5zM9 3v3M15 3v3M8.5 13l2.5 2.5 4.5-5",
  diagnose: "M4 19V9M9 19V4M14 19v-7M19 19v-4M3 21h18",
  plan: "M4 6h16M4 6v13h16V6M8 3v4M16 3v4M8 11h3M8 15h3M14 11h3",
  prove: "M4 6l8-3 8 3v6c0 5-3.5 8.2-8 9.4C7.5 20.2 4 17 4 12zM8.7 12l2.4 2.4 4.4-5",
  setup: "M4 7h8M17 7h3M4 17h3M12 17h8M14.5 4.5v5M8.5 14.5v5",
};

export function JobIcon({ job, size = 17 }: { job: JobKey; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[job]} />
    </svg>
  );
}

export function SearchIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="6" />
      <line x1="15.5" y1="15.5" x2="20" y2="20" />
    </svg>
  );
}
