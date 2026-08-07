import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getMappings, putMappings } from "../lib/api";
import type { MappingsResponse, CampaignMapping } from "../lib/types";
import { Panel } from "../components/ui/Panel";
import { Loading, ErrorState, Empty } from "../components/ui/States";

type Draft = Record<string, { brand: string; region: string; category: string; engine: string; camp_type: string }>;

const FIELDS: { key: "brand" | "region" | "category" | "engine" | "camp_type"; label: string }[] = [
  { key: "brand", label: "Brand" },
  { key: "region", label: "Region" },
  { key: "category", label: "Category" },
  { key: "engine", label: "Engine" },
  { key: "camp_type", label: "Type" },
];

function Editor({ clientId, data }: { clientId: string; data: MappingsResponse }) {
  const qc = useQueryClient();
  const seed: Draft = {};
  for (const c of data.unmapped) {
    const s = data.suggestions.find((x) => x.campaign === c);
    seed[c] = {
      brand: s?.brand ?? "", region: s?.region ?? "", category: s?.category ?? "",
      engine: s?.engine ?? "", camp_type: s?.camp_type ?? "",
    };
  }
  const [draft, setDraft] = useState<Draft>(seed);
  const set = (camp: string, k: keyof Draft[string], v: string) =>
    setDraft((d) => ({ ...d, [camp]: { ...d[camp], [k]: v } }));

  const save = useMutation({
    mutationFn: () => {
      const rows: CampaignMapping[] = Object.entries(draft)
        .filter(([, v]) => v.brand || v.region || v.category || v.engine || v.camp_type)
        .map(([campaign, v]) => ({
          campaign,
          brand: v.brand || null, region: v.region || null, category: v.category || null,
          engine: v.engine || null, camp_type: v.camp_type || null,
        }));
      return putMappings(clientId, rows);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mappings", clientId] });
      qc.invalidateQueries({ queryKey: ["bundle", clientId] });
    },
  });

  const inp = "w-full rounded-[5px] border border-border px-1.5 py-1 text-[12px] outline-none focus:border-accent";

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Campaign Mapping</h1>
        <span className="text-[12px] text-text-muted">{data.unmapped.length} unmapped · {data.mappings.length} mapped</span>
        <div className="ml-auto flex items-center gap-3">
          {save.isSuccess && !save.isPending && <span className="text-[12.5px] text-positive">Saved {save.data.saved}</span>}
          {save.isError && <span className="text-[12.5px] text-negative">{(save.error as Error).message}</span>}
          <button onClick={() => save.mutate()} disabled={save.isPending || !data.unmapped.length}
            className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save mappings"}
          </button>
        </div>
      </div>

      {data.unmapped.length === 0 ? (
        <Empty what="Every campaign is mapped." />
      ) : (
        <Panel title="Unmapped campaigns" sub="Suggestions pre-filled from campaign names — edit and save">
          <div className="overflow-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className="border-b border-border px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">Campaign</th>
                  {FIELDS.map((f) => (
                    <th key={f.key} className="border-b border-border px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.unmapped.map((camp) => (
                  <tr key={camp} className="border-b border-rule last:border-0">
                    <td className="px-2 py-1.5 font-medium">{camp}</td>
                    {FIELDS.map((f) => (
                      <td key={f.key} className="px-2 py-1.5">
                        <input className={inp} value={draft[camp]?.[f.key] ?? ""} onChange={(e) => set(camp, f.key, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {data.mappings.length > 0 && (
        <Panel title="Mapped campaigns" className="mt-4">
          <div className="overflow-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className="border-b border-border px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">Campaign</th>
                  {FIELDS.map((f) => (
                    <th key={f.key} className="border-b border-border px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.mappings.map((m) => (
                  <tr key={m.campaign} className="border-b border-rule last:border-0">
                    <td className="px-2 py-1.5 font-medium">{m.campaign}</td>
                    {FIELDS.map((f) => <td key={f.key} className="px-2 py-1.5 text-text-tertiary">{m[f.key] ?? "—"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

export function CampaignMapping() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["mappings", clientId], queryFn: () => getMappings(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <ErrorState msg="No mapping data." />;
  return <Editor key={clientId} clientId={clientId} data={data} />;
}
