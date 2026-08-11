import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { ResolvedView, FilterName } from "../nav/model";
import { useBundle } from "../hooks/useBundle";

// A view gets the global filter bar when it declares any bundle-driven filter. The rest
// (Sort/Owner/Goal/Budget) are handled inside their own screens.
const DATA_FILTERS = new Set<FilterName>(["Segment", "Dates", "vs", "Campaign"]);

const SEG_OPTS = [
  { v: "all", label: "All" },
  { v: "br", label: "BR" },
  { v: "nb", label: "NB" },
];
const CMP_OPTS = [
  { v: "yoy", label: "YoY" },
  { v: "mom", label: "MoM" },
  { v: "custom", label: "Custom" },
];

// Date presets — mirrors the Google-Ads-style picker, with Custom range pulled to the top.
const PRESETS: { key: string; label: string }[] = [
  { key: "custom", label: "Custom range…" },
  { key: "mtd", label: "MTD (month to date)" },
  { key: "last_month", label: "Last month" },
  { key: "ytd", label: "YTD (year to date)" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week (Sun – Today)" },
  { key: "last_7", label: "Last 7 days" },
  { key: "last_week", label: "Last week (Sun – Sat)" },
  { key: "last_14", label: "Last 14 days" },
  { key: "last_30", label: "Last 30 days" },
  { key: "all", label: "All time" },
  { key: "last_n", label: "Last N days…" },
];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

// Compute {from,to} for a preset relative to today. Returns {} for "all" (no range).
function presetRange(key: string, n = 7): { from?: string; to?: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const y = today.getFullYear(), m = today.getMonth();
  const yest = addDays(today, -1);
  switch (key) {
    case "all": return {};
    case "mtd": return { from: iso(new Date(y, m, 1)), to: iso(today) };
    case "last_month": return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "ytd": return { from: iso(new Date(y, 0, 1)), to: iso(today) };
    case "today": return { from: iso(today), to: iso(today) };
    case "yesterday": return { from: iso(yest), to: iso(yest) };
    case "this_week": return { from: iso(addDays(today, -today.getDay())), to: iso(today) };
    case "last_7": return { from: iso(addDays(yest, -6)), to: iso(yest) };
    case "last_week": { const sun = addDays(today, -today.getDay() - 7); return { from: iso(sun), to: iso(addDays(sun, 6)) }; }
    case "last_14": return { from: iso(addDays(yest, -13)), to: iso(yest) };
    case "last_30": return { from: iso(addDays(yest, -29)), to: iso(yest) };
    case "last_n": return { from: iso(addDays(yest, -(Math.max(1, n) - 1))), to: iso(yest) };
    default: return {};
  }
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">{children}</span>;
}

function Toggle({ options, value, onChange }: { options: { v: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex overflow-hidden rounded-[6px] border border-border-strong">
      {options.map((o, i) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 text-[12px] ${i > 0 ? "border-l border-border-strong" : ""} ${value === o.v ? "bg-ink font-medium text-accent" : "bg-surface hover:bg-row-hover"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[190px] rounded-[6px] border border-border-strong bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent"
    >
      <option value="all">All</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function DatesControl({ from, to, dp, apply }: { from: string; to: string; dp: string; apply: (u: Record<string, string | null>) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "custom" | "lastn">("list");
  const [n, setN] = useState("7");
  const [cf, setCf] = useState(from);
  const [ct, setCt] = useState(to);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const summary = dp ? PRESETS.find((p) => p.key === dp)?.label ?? "All time" : from || to ? `${from || "…"} – ${to || "…"}` : "All time";
  const choose = (key: string) => {
    if (key === "custom") { setCf(from); setCt(to); setMode("custom"); return; }
    if (key === "last_n") { setMode("lastn"); return; }
    const r = presetRange(key);
    apply({ from: r.from ?? null, to: r.to ?? null, dp: key });
    setOpen(false);
    setMode("list");
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen((o) => !o); setMode("list"); }}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-[6px] border px-[9px] py-1 text-[12px] hover:border-accent ${from || to ? "border-accent bg-accent/10" : "border-border-strong bg-surface"}`}
      >
        <span className="font-medium">{summary}</span>
        <span className="text-text-disabled">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[220px] rounded-[8px] border border-border bg-surface p-1 shadow-[0_8px_28px_rgba(26,26,26,0.14)]">
          {mode === "list" && PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => choose(p.key)}
              className={`flex w-full items-center rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-row-hover ${dp === p.key ? "font-semibold" : ""}`}
            >
              {p.label}
            </button>
          ))}
          {mode === "custom" && (
            <div className="w-[220px] p-1.5">
              <label className="mb-2 flex items-center justify-between gap-2 text-[12px]">
                <span className="text-text-muted">From</span>
                <input type="date" value={cf} onChange={(e) => setCf(e.target.value)} className="rounded-[6px] border border-border px-1.5 py-1 text-[12px] outline-none focus:border-accent" />
              </label>
              <label className="mb-2 flex items-center justify-between gap-2 text-[12px]">
                <span className="text-text-muted">To</span>
                <input type="date" value={ct} onChange={(e) => setCt(e.target.value)} className="rounded-[6px] border border-border px-1.5 py-1 text-[12px] outline-none focus:border-accent" />
              </label>
              <button
                onClick={() => { apply({ from: cf || null, to: ct || null, dp: "custom" }); setOpen(false); setMode("list"); }}
                className="mt-1 w-full rounded-[6px] bg-ink px-2 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                disabled={!cf && !ct}
              >
                Apply
              </button>
            </div>
          )}
          {mode === "lastn" && (
            <div className="flex w-[220px] items-center gap-2 p-1.5">
              <span className="text-[12px] text-text-muted">Last</span>
              <input type="number" min={1} value={n} onChange={(e) => setN(e.target.value)} className="w-16 rounded-[6px] border border-border px-1.5 py-1 text-right text-[12px] outline-none focus:border-accent" />
              <span className="text-[12px] text-text-muted">days</span>
              <button
                onClick={() => { const r = presetRange("last_n", Number(n) || 7); apply({ from: r.from ?? null, to: r.to ?? null, dp: "last_n" }); setOpen(false); setMode("list"); }}
                className="ml-auto rounded-[6px] bg-ink px-2 py-1 text-[12px] font-medium text-white"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContextBar({ view, clientId = "" }: { view?: ResolvedView; clientId?: string }) {
  const [sp, setSp] = useSearchParams();
  const filters = view?.filters ?? [];
  const showBar = filters.some((f) => DATA_FILTERS.has(f)) && !!clientId;
  const { data } = useBundle(clientId, showBar);

  // Ordered breadcrumb trail: Job › Category (the parents that lead to this view).
  const trail = view ? [view.job.title, view.category?.title].filter(Boolean) : [];
  const set = (k: string, v: string, dflt: string) => {
    const next = new URLSearchParams(sp);
    if (!v || v === dflt) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };
  const applyMany = (u: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(u)) v == null ? next.delete(k) : next.set(k, v);
    setSp(next, { replace: true });
  };

  const g = (k: string, d = "all") => sp.get(k) || d;
  const fm = data?.meta?.filters_meta ?? {};

  return (
    <div className="sticky top-0 z-20 border-b border-strip-border bg-strip-bg">
      <div className="flex h-11 items-center gap-1.5 px-6 text-[13px]">
        {trail.map((c) => (
          <span key={c} className="flex items-center gap-1.5 text-text-muted">
            {c}
            <span className="text-text-disabled">›</span>
          </span>
        ))}
        <span className="font-semibold text-ink">{view?.title ?? "—"}</span>
      </div>
      {showBar && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-strip-border px-6 py-2">
          <div className="flex items-center gap-1.5">
            <Label>Segment</Label>
            <Toggle options={SEG_OPTS} value={g("seg")} onChange={(v) => set("seg", v, "all")} />
          </div>
          <div className="flex items-center gap-1.5">
            <Label>Campaign</Label>
            <Select value={g("campaign")} onChange={(v) => set("campaign", v, "all")} options={fm.campaigns ?? []} />
          </div>
          {(fm.types?.length ?? 0) > 1 && (
            <div className="flex items-center gap-1.5">
              <Label>Type</Label>
              <Select value={g("type")} onChange={(v) => set("type", v, "all")} options={fm.types ?? []} />
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Label>Region</Label>
            <Select value={g("region")} onChange={(v) => set("region", v, "all")} options={fm.regions ?? []} />
          </div>
          <div className="flex items-center gap-1.5">
            <Label>Category</Label>
            <Select value={g("category")} onChange={(v) => set("category", v, "all")} options={fm.categories ?? []} />
          </div>
          <div className="flex items-center gap-1.5">
            <Label>Brand</Label>
            <Select value={g("brand")} onChange={(v) => set("brand", v, "all")} options={fm.brands ?? []} />
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Label>Dates</Label>
            <DatesControl from={sp.get("from") || ""} to={sp.get("to") || ""} dp={sp.get("dp") || ""} apply={applyMany} />
          </div>
          <div className="flex items-center gap-1.5">
            <Label>vs</Label>
            <Toggle options={CMP_OPTS} value={g("compare", "yoy")} onChange={(v) => set("compare", v, "yoy")} />
          </div>
        </div>
      )}
    </div>
  );
}
