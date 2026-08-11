import { useParams } from "react-router-dom";
import { VIEW_INDEX } from "../nav/model";

// Shown for any view not yet rebuilt in the new interface. Keeps the navigation honest and
// complete (every view is reachable) rather than hiding unbuilt screens.
export function Placeholder() {
  const { view } = useParams();
  const rv = view ? VIEW_INDEX[view] : undefined;
  return (
    <div className="mx-auto max-w-[640px] px-6 pt-[88px] text-center">
      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-text-muted">
        {rv?.category?.title ?? rv?.job.title ?? ""}
      </div>
      <h1 className="mt-2 font-display text-[34px] tracking-[-0.01em]">{rv?.title ?? "Not found"}</h1>
      <p className="mt-4 text-[13px] text-text-tertiary [text-wrap:pretty]">
        This view isn't rebuilt in the new interface yet. It inherits the patterns every screen shares — a context bar
        with only its applicable filters, tables with the single honest totals-row rule, and the evidence drawer for
        drill-downs.
      </p>
    </div>
  );
}
