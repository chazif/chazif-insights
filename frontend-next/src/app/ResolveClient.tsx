import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getClients } from "../lib/api";
import { DEFAULT_VIEW } from "../nav/model";

// Landing at /next with no client: resolve the most recently-updated client that has data
// and redirect to it, so the app always opens on a real account.
export function ResolveClient() {
  const { data, error } = useQuery({ queryKey: ["clients"], queryFn: getClients });
  const navigate = useNavigate();

  useEffect(() => {
    if (!data) return;
    const withData = data
      .filter((c) => (c.reports_loaded ?? 0) > 0)
      .sort((a, b) => String(b.last_upload ?? "").localeCompare(String(a.last_upload ?? "")));
    const target = withData[0]?.client_id ?? data[0]?.client_id;
    if (target) navigate(`/c/${target}/${DEFAULT_VIEW}`, { replace: true });
  }, [data, navigate]);

  return (
    <div className="grid h-screen place-items-center font-ui text-[12.5px] text-text-disabled">
      {error ? `Could not load clients: ${(error as Error).message}` : "Loading…"}
    </div>
  );
}
