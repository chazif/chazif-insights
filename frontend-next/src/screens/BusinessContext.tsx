import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getConfig, updateConfig } from "../lib/api";
import type { ClientConfig } from "../lib/types";
import { Panel } from "../components/ui/Panel";
import { Loading, ErrorState } from "../components/ui/States";

const LIST_FIELDS: { key: keyof ClientConfig; label: string; hint: string }[] = [
  { key: "brand_terms", label: "Brand terms", hint: "Your brand — excluded from non-brand analysis" },
  { key: "product_categories", label: "Product categories", hint: "What the business sells — the relevance signal" },
  { key: "competitors_conquest", label: "Conquest competitors", hint: "Real conquest targets" },
  { key: "competitors_friendly", label: "Friendly competitors", hint: "Never negate (industry relationships)" },
  { key: "waste_exclusions", label: "Waste exclusions", hint: "Term substrings never flagged as waste" },
];
const THRESHOLDS: { key: string; label: string }[] = [
  { key: "smart_bidding_floor", label: "Smart-bidding floor (conv/mo)" },
  { key: "low_vol_conv", label: "Low-volume conversions" },
  { key: "low_vol_spend", label: "Low-volume spend ($)" },
  { key: "qs_floor", label: "QS danger-zone ceiling" },
  { key: "monthly_budget", label: "Monthly budget ($)" },
];

function ConfigForm({ clientId, initial }: { clientId: string; initial: ClientConfig }) {
  const qc = useQueryClient();
  const [lists, setLists] = useState<Record<string, string>>(
    Object.fromEntries(LIST_FIELDS.map((f) => [f.key, ((initial[f.key] as string[]) ?? []).join("\n")]))
  );
  const [th, setTh] = useState<Record<string, string>>(
    Object.fromEntries(THRESHOLDS.map((t) => [t.key, initial.thresholds?.[t.key as keyof typeof initial.thresholds] ?? ""].map(String) as [string, string]))
  );
  const [notes, setNotes] = useState(initial.notes ?? "");

  const save = useMutation({
    mutationFn: () => {
      const patch: Partial<ClientConfig> = { notes };
      for (const f of LIST_FIELDS) {
        patch[f.key] = lists[f.key].split(/[\n,]/).map((s) => s.trim()).filter(Boolean) as never;
      }
      const t: Record<string, number | null> = {};
      for (const x of THRESHOLDS) {
        const v = th[x.key].trim();
        t[x.key] = v === "" ? null : Number(v);
      }
      patch.thresholds = t as never;
      return updateConfig(clientId, patch);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", clientId] });
      qc.invalidateQueries({ queryKey: ["bundle", clientId] });
    },
  });

  return (
    <div className="mx-auto max-w-[960px] px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Business Context</h1>
        <div className="ml-auto flex items-center gap-3">
          {save.isSuccess && !save.isPending && <span className="text-[12.5px] text-positive">Saved</span>}
          {save.isError && <span className="text-[12.5px] text-negative">{(save.error as Error).message}</span>}
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
        {LIST_FIELDS.map((f) => (
          <Panel key={f.key} title={f.label} sub={f.hint}>
            <textarea
              value={lists[f.key]}
              onChange={(e) => setLists((s) => ({ ...s, [f.key]: e.target.value }))}
              rows={5}
              placeholder="One per line…"
              className="w-full resize-y rounded-[7px] border border-border px-2.5 py-2 text-[12.5px] outline-none focus:border-accent"
            />
          </Panel>
        ))}
        <Panel title="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={5}
            className="w-full resize-y rounded-[7px] border border-border px-2.5 py-2 text-[12.5px] outline-none focus:border-accent" />
        </Panel>
      </div>

      <Panel title="Thresholds" sub="Override the analyzer defaults" className="mt-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 max-[600px]:grid-cols-1">
          {THRESHOLDS.map((t) => (
            <label key={t.key} className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="text-text-secondary">{t.label}</span>
              <input type="number" value={th[t.key]} onChange={(e) => setTh((s) => ({ ...s, [t.key]: e.target.value }))}
                className="w-28 rounded-[6px] border border-border px-2 py-1 text-right font-mono text-[12.5px] outline-none focus:border-accent" />
            </label>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function BusinessContext() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["config", clientId], queryFn: () => getConfig(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <ErrorState msg="No config for this client." />;
  return <ConfigForm key={clientId} clientId={clientId} initial={data} />;
}
