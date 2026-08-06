import type { ResolvedView } from "../nav/model";

// 48px context bar. Left: screen title + breadcrumb subtitle. Right: ONLY the filters that
// actually apply to this screen (declared per view). A screen with none says so, rather than
// rendering a filter bar that controls nothing. Filter chips are non-interactive in this
// increment — they become live controls when the data views are wired up.
export function ContextBar({ view }: { view?: ResolvedView }) {
  const filters = view?.filters ?? [];
  const subtitle = view ? [view.job.title, view.category?.title].filter(Boolean).join(" › ") : "";
  return (
    <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-strip-border bg-strip-bg px-6">
      <span className="text-[13px] font-semibold text-ink">{view?.title ?? "—"}</span>
      {subtitle && <span className="text-[12px] text-text-muted">{subtitle}</span>}
      <div className="ml-auto flex items-center gap-2">
        {filters.length === 0 ? (
          <span className="text-[11.5px] italic text-text-disabled">no filters apply on this screen</span>
        ) : (
          filters.map((f) => (
            <span
              key={f}
              className="cursor-default whitespace-nowrap rounded-[6px] border border-border-strong bg-surface px-[9px] py-1 text-[12px] hover:border-accent"
            >
              <span className="text-text-muted">{f}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
