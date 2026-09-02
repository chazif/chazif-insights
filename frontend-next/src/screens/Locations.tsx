import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addLocation, deleteLocation, getLocations } from "../lib/api";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState } from "../components/ui/States";

export function Locations() {
  const { clientId = "" } = useParams();
  const qc = useQueryClient();
  const locs = useQuery({ queryKey: ["locations", clientId], queryFn: () => getLocations(clientId) });
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [warn, setWarn] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => addLocation(clientId, name.trim(), address.trim()),
    onSuccess: (r) => {
      setName("");
      setAddress("");
      setWarn(r.geocoded ? null : "Couldn't place that address on the map — check it and try again.");
      qc.invalidateQueries({ queryKey: ["locations", clientId] });
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => deleteLocation(clientId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations", clientId] }),
  });

  if (locs.isLoading) return <Loading />;
  if (locs.error) return <ErrorState msg={(locs.error as Error).message} />;
  const rows = locs.data?.locations ?? [];

  return (
    <div className="mx-auto max-w-[920px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">Locations</h2>
        <div className="text-[12.5px] text-text-muted">
          Physical store / office addresses — shown as pins on the Map tab. Each address is placed on the map automatically when you add it.
        </div>
      </div>

      <Panel title="Add a location">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[12px]">
            <div className="mb-1 text-text-muted">Name (optional)</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Main store" className="w-48 rounded-[7px] border border-border-strong px-2.5 py-1.5 text-[13px] focus:border-ink focus:outline-none" />
          </label>
          <label className="min-w-[300px] flex-1 text-[12px]">
            <div className="mb-1 text-text-muted">Full address</div>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && address.trim()) add.mutate(); }}
              placeholder="123 Main St, City, ST 00000, Country"
              className="w-full rounded-[7px] border border-border-strong px-2.5 py-1.5 text-[13px] focus:border-ink focus:outline-none"
            />
          </label>
          <button onClick={() => add.mutate()} disabled={!address.trim() || add.isPending} className="rounded-[7px] bg-ink px-3.5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </div>
        {add.isError && <p className="mt-2 text-[12.5px] text-negative">{(add.error as Error).message}</p>}
        {warn && <p className="mt-2 text-[12.5px] text-[#92400e]">{warn}</p>}
      </Panel>

      <div className="mt-6">
        <Panel title={`Saved locations (${rows.length})`}>
          {rows.length === 0 ? (
            <p className="text-[12.5px] text-text-muted">No locations yet. Add one above and it'll appear as a pin on the Map tab.</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  {["Name", "Address", "On map", ""].map((h, i) => (
                    <th key={h} className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-rule">
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-text-tertiary">{r.address}</td>
                    <td className="px-3 py-2">{r.lat != null && r.lng != null ? <Pill tone="pos">Placed</Pill> : <Pill tone="warn">Not placed</Pill>}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => del.mutate(r.id)} disabled={del.isPending} className="text-[12px] text-negative hover:underline disabled:opacity-50">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
