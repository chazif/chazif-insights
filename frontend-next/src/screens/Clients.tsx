import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getClients, createClient } from "../lib/api";
import { Panel } from "../components/ui/Panel";
import { Loading, ErrorState } from "../components/ui/States";

export function Clients() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["clients"], queryFn: getClients });
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => createClient(name.trim()),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const clients = data ?? [];

  return (
    <div className="mx-auto max-w-[960px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Clients</h1>

      <Panel title="Add a client" sub="A slug id is derived from the name; attach data via Setup → Upload Data">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()}
            placeholder="Client name"
            className="min-w-[240px] flex-1 rounded-[7px] border border-border px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
          />
          <button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}
            className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {create.isPending ? "Adding…" : "Add client"}
          </button>
          {create.isError && <span className="text-[12.5px] text-negative">{(create.error as Error).message}</span>}
        </div>
      </Panel>

      <div className="mt-5 overflow-auto rounded-[10px] border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-surface-alt">
            <tr>
              {["Client", "ID", "Google CID", "Reports", "Last upload"].map((h, i) => (
                <th key={h} className={`whitespace-nowrap border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted ${i >= 3 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.client_id} className="border-b border-rule last:border-0 hover:bg-row-hover">
                <td className="px-3 py-2 font-medium">
                  <Link to={`/c/${c.client_id}/brief`} className="hover:underline">{c.name}</Link>
                </td>
                <td className="px-3 py-2 font-mono text-text-tertiary">{c.client_id}</td>
                <td className="px-3 py-2 font-mono text-text-tertiary">{c.google_customer_id ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{c.reports_loaded ?? 0}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-text-tertiary">
                  {c.last_upload ? new Date(c.last_upload).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
