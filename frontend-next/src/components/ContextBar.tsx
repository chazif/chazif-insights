import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { ResolvedView, FilterName } from "../nav/model";
import { useBundle } from "../hooks/useBundle";

// The filters the top bar actually drives (they re-compute the bundle server-side). The rest
// declared on a view (Sort/Owner/Goal/Budget) are handled inside that screen, so we don't
// render dead chips for them here.
const DATA_FILTERS = new Set<FilterName>(["Segment", "Dates", "vs", "Campaign"]);

const SEG_OPTS = [
  { v: "all", label: "All" },
  { v: "nb", label: "Non-brand" },
  { v: "br", label: "Brand" },
];
const CMP_OPTS = [
  { v: "yoy", label: "YoY" },
  { v: "mom", label: "MoM" },
];

function Dropdown({ label, summary, active, children }: { label: string; summary: string; active: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-[6px] border px-[9px] py-1 text-[12px] hover:border-accent ${active ? "border-accent bg-accent/10" : "border-border-strong bg-surface"}`}
      >
        <span className="text-text-muted">{label}</span>
        <span className="font-medium">{summary}</span>
        <span className="text-text-disabled">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[180px] rounded-[8px] border border-border bg-surface p-1 shadow-[0_8px_28px_rgba(26,26,26,0.14)]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Item({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-row-hover ${selected ? "font-semibold" : ""}`}>
      <span className={`text-accent ${selected ? "opacity-100" : "opacity-0"}`}>✓</span>
      {children}
    </button>
  );
}

export function ContextBar({ view, clientId = "" }: { view?: ResolvedView; clientId?: string }) {
  const [sp, setSp] = useSearchParams();
  const filters = view?.filters ?? [];
  const handled = filters.filter((f) => DATA_FILTERS.has(f));
  const { data } = useBundle(clientId, handled.length > 0 && !!clientId);

  const subtitle = view ? [view.job.title, view.category?.title].filter(Boolean).join(" › ") : "";
  const setParam = (k: string, v: string, dflt: string) => {
    const next = new URLSearchParams(sp);
    if (!v || v === dflt) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const seg = sp.get("seg") || "all";
  const cmp = sp.get("compare") || "yoy";
  const campaign = sp.get("campaign") || "all";
  const from = sp.get("from") || "";
  const to = sp.get("to") || "";
  const months: string[] = (data?.total_trend ?? []).map((t) => t.Month);
  const campaigns: string[] = data?.meta?.filters_meta?.campaigns ?? [];
  const dateSummary = from || to ? `${from || "start"} – ${to || "end"}` : "All";

  const control = (f: FilterName) => {
    if (f === "Segment")
      return (
        <Dropdown key={f} label="Segment" summary={SEG_OPTS.find((o) => o.v === seg)?.label ?? "All"} active={seg !== "all"}>
          {(close) => SEG_OPTS.map((o) => <Item key={o.v} selected={seg === o.v} onClick={() => { setParam("seg", o.v, "all"); close(); }}>{o.label}</Item>)}
        </Dropdown>
      );
    if (f === "vs")
      return (
        <Dropdown key={f} label="vs" summary={CMP_OPTS.find((o) => o.v === cmp)?.label ?? "YoY"} active={cmp !== "yoy"}>
          {(close) => CMP_OPTS.map((o) => <Item key={o.v} selected={cmp === o.v} onClick={() => { setParam("compare", o.v, "yoy"); close(); }}>{o.label}</Item>)}
        </Dropdown>
      );
    if (f === "Campaign")
      return (
        <Dropdown key={f} label="Campaign" summary={campaign === "all" ? "All" : campaign.length > 22 ? campaign.slice(0, 20) + "…" : campaign} active={campaign !== "all"}>
          {(close) => (
            <div className="max-h-[300px] overflow-auto">
              <Item selected={campaign === "all"} onClick={() => { setParam("campaign", "all", "all"); close(); }}>All campaigns</Item>
              {campaigns.map((c) => <Item key={c} selected={campaign === c} onClick={() => { setParam("campaign", c, "all"); close(); }}>{c}</Item>)}
            </div>
          )}
        </Dropdown>
      );
    if (f === "Dates")
      return (
        <Dropdown key={f} label="Dates" summary={dateSummary} active={!!(from || to)}>
          {(close) => (
            <div className="w-[220px] p-1.5">
              {(["from", "to"] as const).map((which) => (
                <label key={which} className="mb-2 flex items-center justify-between gap-2 text-[12px]">
                  <span className="capitalize text-text-muted">{which}</span>
                  <select
                    value={which === "from" ? from : to}
                    onChange={(e) => setParam(which, e.target.value, "")}
                    className="min-w-[130px] rounded-[6px] border border-border px-1.5 py-1 text-[12px] outline-none focus:border-accent"
                  >
                    <option value="">{which === "from" ? "Earliest" : "Latest"}</option>
                    {months.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              ))}
              <button
                onClick={() => { const next = new URLSearchParams(sp); next.delete("from"); next.delete("to"); setSp(next, { replace: true }); close(); }}
                className="mt-1 w-full rounded-[6px] border border-border-strong px-2 py-1 text-[12px] hover:border-ink"
              >
                All dates
              </button>
            </div>
          )}
        </Dropdown>
      );
    return null;
  };

  return (
    <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-strip-border bg-strip-bg px-6">
      <span className="text-[13px] font-semibold text-ink">{view?.title ?? "—"}</span>
      {subtitle && <span className="text-[12px] text-text-muted">{subtitle}</span>}
      <div className="ml-auto flex items-center gap-2">
        {handled.length === 0 ? (
          filters.length === 0 ? <span className="text-[11.5px] italic text-text-disabled">no filters apply on this screen</span> : null
        ) : (
          handled.map(control)
        )}
      </div>
    </div>
  );
}
