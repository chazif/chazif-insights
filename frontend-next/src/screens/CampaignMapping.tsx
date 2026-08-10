import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getMappings, putMappings, approveMappings, uploadMappingFile } from "../lib/api";
import type { MappingsResponse, CampaignMapping as MappingRow } from "../lib/types";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState, Empty } from "../components/ui/States";

type Fields = { brand: string; region: string; category: string; engine: string; camp_type: string };
const FIELDS: { key: keyof Fields; label: string }[] = [
  { key: "brand", label: "Brand" },
  { key: "region", label: "Region" },
  { key: "category", label: "Category" },
  { key: "engine", label: "Engine" },
  { key: "camp_type", label: "Type" },
];

const toFields = (m: MappingRow): Fields => ({
  brand: m.brand ?? "", region: m.region ?? "", category: m.category ?? "",
  engine: m.engine ?? "", camp_type: m.camp_type ?? "",
});
const confTone = (c: number) => (c >= 0.8 ? "pos" : c >= 0.5 ? "warn" : "neg") as "pos" | "warn" | "neg";

function Editor({ clientId, data }: { clientId: string; data: MappingsResponse }) {
  const qc = useQueryClient();
  const initial = useMemo(() => Object.fromEntries(data.mappings.map((m) => [m.campaign, toFields(m)])), [data]);
  const [draft, setDraft] = useState<Record<string, Fields>>(initial);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (camp: string, k: keyof Fields, v: string) => setDraft((d) => ({ ...d, [camp]: { ...d[camp], [k]: v } }));

  const dirty = data.mappings.filter((m) => {
    const a = initial[m.campaign], b = draft[m.campaign];
    return b && FIELDS.some((f) => a[f.key] !== b[f.key]);
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["mappings", clientId] });
    qc.invalidateQueries({ queryKey: ["bundle", clientId] });
  };
  const save = useMutation({
    mutationFn: () =>
      putMappings(clientId, dirty.map((m) => {
        const b = draft[m.campaign];
        return { campaign: m.campaign, brand: b.brand || null, region: b.region || null,
                 category: b.category || null, engine: b.engine || null, camp_type: b.camp_type || null };
      })),
    onSuccess: invalidate,
  });
  const approveAll = useMutation({ mutationFn: () => approveMappings(clientId), onSuccess: invalidate });
  const upload = useMutation({
    mutationFn: (f: File) => uploadMappingFile(clientId, f),
    onSuccess: invalidate,
  });

  const pending = data.pending ?? 0;
  const inp = "w-full rounded-[5px] border border-border px-1.5 py-1 text-[12px] outline-none focus:border-accent";
  const err = (save.error ?? approveAll.error ?? upload.error) as Error | null;

  return (
    <div className="mx-auto max-w-[1220px] px-6 py-6">
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Campaign Mapping</h1>
        <span className="text-[12px] text-text-muted">{data.total ?? data.mappings.length} campaigns</span>
        {pending > 0 && <Pill tone="warn">{pending} pending review</Pill>}
        <div className="ml-auto flex items-center gap-2">
          {err && <span className="text-[12.5px] text-negative">{err.message}</span>}
          {save.isSuccess && !save.isPending && !dirty.length && <span className="text-[12.5px] text-positive">Saved</span>}
          {pending > 0 && (
            <button onClick={() => approveAll.mutate()} disabled={approveAll.isPending}
              className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[13px] hover:border-ink disabled:opacity-50">
              {approveAll.isPending ? "Approving…" : "Approve all"}
            </button>
          )}
          <button onClick={() => save.mutate()} disabled={save.isPending || !dirty.length}
            className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {save.isPending ? "Saving…" : `Save changes${dirty.length ? ` (${dirty.length})` : ""}`}
          </button>
        </div>
      </div>
      <p className="mb-4 text-[12.5px] text-text-muted">
        The single source of campaign attribution — every view resolves Brand / Region / Category from this table.
        New campaigns are auto-mapped with a confidence score; review and approve, edit inline, or upload a mapping file. Your edits override the auto-mapping.
      </p>

      {data.mappings.length === 0 ? (
        <Empty what="No campaigns yet — upload data first (Setup → Upload Data)." />
      ) : (
        <Panel>
          <div className="overflow-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["Campaign", ...FIELDS.map((f) => f.label), "Confidence", "Status"].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-border px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.mappings.map((m) => {
                  const conf = m.confidence ?? 1;
                  return (
                    <tr key={m.campaign} className="border-b border-rule last:border-0">
                      <td className="max-w-[300px] px-2 py-1.5 font-medium">{m.campaign}</td>
                      {FIELDS.map((f) => (
                        <td key={f.key} className="px-2 py-1.5">
                          <input className={inp} value={draft[m.campaign]?.[f.key] ?? ""} onChange={(e) => set(m.campaign, f.key, e.target.value)} />
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {m.source === "auto" ? <Pill tone={confTone(conf)}>{Math.round(conf * 100)}%</Pill> : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <Pill tone={m.status === "pending" ? "warn" : "pos"}>{m.status ?? "approved"}</Pill>
                        <span className="ml-1.5 text-[11px] text-text-muted">{m.source ?? "user"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Upload a mapping file" sub="CSV/XLSX with Campaign + Brand / Region / Category (Engine, Type optional) — overrides auto-mapping" className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".csv,.xlsx"
            className="text-[12.5px] file:mr-3 file:rounded-[6px] file:border file:border-border-strong file:bg-surface-alt file:px-2.5 file:py-1 file:text-[12px] hover:file:border-ink" />
          <button onClick={() => { const f = fileRef.current?.files?.[0]; if (f) upload.mutate(f); }} disabled={upload.isPending}
            className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[13px] hover:border-ink disabled:opacity-50">
            {upload.isPending ? "Uploading…" : "Upload"}
          </button>
          {upload.isSuccess && <span className="text-[12.5px] text-positive">Loaded {upload.data.saved} mappings</span>}
        </div>
      </Panel>
    </div>
  );
}

export function CampaignMapping() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["mappings", clientId], queryFn: () => getMappings(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <ErrorState msg="No mapping data." />;
  return <Editor key={clientId + ":" + (data.mappings?.length ?? 0)} clientId={clientId} data={data} />;
}
