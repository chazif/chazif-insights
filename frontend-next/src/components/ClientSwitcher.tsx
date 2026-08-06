import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getClients } from "../lib/api";

export function ClientSwitcher({ clientId, view }: { clientId: string; view: string }) {
  const { data } = useQuery({ queryKey: ["clients"], queryFn: getClients });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const clients = (data ?? []).filter((c) => (c.reports_loaded ?? 0) > 0);
  const current = data?.find((c) => c.client_id === clientId);
  const name = current?.name ?? clientId;
  const initials =
    name
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "–";

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={ref} className="relative px-3 pb-3">
      <div className="mb-1 px-[2px] text-[9.5px] font-semibold uppercase tracking-[0.09em] text-text-disabled">Client</div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-[7px] border border-[#374151] bg-ink px-2 py-1.5 text-left"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] bg-border font-mono text-[9px] font-bold text-[#1f2937]">
          {initials}
        </span>
        <span className="truncate text-[12.5px] font-medium text-text-disabled">{name}</span>
        <span className="ml-auto text-[10px] text-text-disabled">▾</span>
      </button>
      {open && (
        <div className="absolute left-3 right-3 z-40 mt-1 max-h-[280px] overflow-auto rounded-[8px] border border-[#374151] bg-ink py-1 shadow-[0_8px_28px_rgba(0,0,0,0.4)]">
          {clients.map((c) => (
            <button
              key={c.client_id}
              onClick={() => {
                setOpen(false);
                navigate(`/c/${c.client_id}/${view}`);
              }}
              className={`block w-full truncate px-3 py-1.5 text-left text-[12.5px] ${
                c.client_id === clientId ? "text-accent" : "text-text-disabled hover:bg-white/[0.06]"
              }`}
            >
              {c.name}
            </button>
          ))}
          {clients.length === 0 && <div className="px-3 py-1.5 text-[12px] text-text-disabled">No clients.</div>}
        </div>
      )}
    </div>
  );
}
