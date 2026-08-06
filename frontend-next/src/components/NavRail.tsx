import { Link } from "react-router-dom";
import { NAV, type JobDef, type CategoryDef, type ViewDef } from "../nav/model";
import { JobIcon, SearchIcon } from "./ui/JobIcon";
import { ClientSwitcher } from "./ClientSwitcher";

interface Props {
  clientId: string;
  activeSlug: string;
  open: boolean;
  openGroups: Set<string>;
  toggleGroup: (id: string) => void;
  onToggleRail: () => void;
  onExpandWithGroup: (jobId: string) => void;
  onOpenPalette: () => void;
  onViewSelected: () => void;
}

const jobActive = (job: JobDef, slug: string) =>
  (job.views ?? []).some((v) => v.slug === slug) || (job.categories ?? []).some((c) => c.views.some((v) => v.slug === slug));
const catActive = (cat: CategoryDef, slug: string) => cat.views.some((v) => v.slug === slug);

function ViewRow({ clientId, view, active, depth, onSelect }: { clientId: string; view: ViewDef; active: boolean; depth: 2 | 3; onSelect: () => void }) {
  const ml = depth === 3 ? "ml-[22px]" : "ml-[9px]";
  const dot = !view.built ? "bg-transparent" : active ? "bg-ink" : "bg-text-muted";
  return (
    <Link
      to={`/c/${clientId}/${view.slug}`}
      onClick={onSelect}
      className={`flex items-center gap-2 rounded-[6px] px-[9px] py-1 text-[12px] leading-[1.35] ${ml} ${
        active ? "bg-accent font-semibold text-ink" : "text-text-disabled hover:bg-white/[0.06]"
      }`}
    >
      <span className={`h-1 w-1 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{view.title}</span>
    </Link>
  );
}

export function NavRail(props: Props) {
  const { clientId, activeSlug, open, openGroups, toggleGroup, onToggleRail, onExpandWithGroup, onOpenPalette, onViewSelected } = props;

  // ---- collapsed (56px) icon rail ----
  if (!open) {
    return (
      <aside className="z-[30] flex w-[56px] shrink-0 flex-col items-center gap-[7px] bg-rail py-4 text-text-disabled">
        <div className="grid h-5 w-5 place-items-center rounded-[5px] bg-accent font-mono text-[11px] font-bold text-ink">N</div>
        <button onClick={onToggleRail} className="grid h-7 w-8 place-items-center rounded-[7px] hover:bg-white/[0.12]" title="Expand">
          ≡
        </button>
        <button onClick={onOpenPalette} className="grid h-7 w-8 place-items-center rounded-[7px] hover:bg-white/[0.12]" title="Search (⌘K)">
          <SearchIcon />
        </button>
        <div className="my-1 h-px w-7 bg-white/[0.10]" />
        {NAV.map((job) => {
          const active = jobActive(job, activeSlug);
          return (
            <button
              key={job.key}
              onClick={() => onExpandWithGroup("job:" + job.key)}
              title={job.title}
              className={`grid h-8 w-8 place-items-center rounded-[8px] ${active ? "bg-accent text-ink" : "hover:bg-white/[0.12]"}`}
            >
              <JobIcon job={job.key} />
            </button>
          );
        })}
      </aside>
    );
  }

  // ---- expanded (248px) ----
  return (
    <aside className="z-[30] flex w-[248px] shrink-0 flex-col bg-rail text-text-disabled">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <div className="grid h-5 w-5 place-items-center rounded-[5px] bg-accent font-mono text-[11px] font-bold text-ink">N</div>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#f9fafb]">SearchNex</span>
        <button onClick={onToggleRail} className="ml-auto grid h-6 w-6 place-items-center rounded-[6px] text-text-disabled hover:bg-white/[0.12] hover:text-[#f9fafb]" title="Collapse">
          «
        </button>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={onOpenPalette}
          className="flex w-full items-center gap-2 rounded-[7px] border border-white/[0.10] bg-white/[0.06] px-[9px] py-[7px] text-[12.5px] text-text-disabled hover:border-white/20"
        >
          <SearchIcon size={13} />
          Search anything
          <span className="ml-auto font-mono text-[10.5px] opacity-55">⌘K</span>
        </button>
      </div>

      <ClientSwitcher clientId={clientId} view={activeSlug} />

      <nav className="flex-1 overflow-auto px-2 pb-4">
        {NAV.map((job) => {
          const jobId = "job:" + job.key;
          const jobOpen = openGroups.has(jobId);
          return (
            <div key={job.key} className="mb-[2px]">
              <button
                onClick={() => toggleGroup(jobId)}
                className={`flex w-full items-center gap-1.5 rounded-[6px] px-[9px] py-1 text-[9.5px] font-semibold uppercase tracking-[0.1em] hover:bg-white/[0.06] ${
                  jobOpen ? "text-[#f9fafb]" : "text-text-disabled"
                }`}
              >
                <span className="w-[7px] text-center font-mono text-[10px]">{jobOpen ? "−" : "+"}</span>
                {job.title}
              </button>

              {jobOpen && (
                <div className="mt-[2px]">
                  {(job.views ?? []).map((view) => (
                    <ViewRow key={view.slug} clientId={clientId} view={view} active={view.slug === activeSlug} depth={2} onSelect={onViewSelected} />
                  ))}
                  {(job.categories ?? []).map((cat) => {
                    const catId = "cat:" + job.key + "/" + cat.title;
                    const catOpen = openGroups.has(catId);
                    const highlight = catOpen || catActive(cat, activeSlug);
                    return (
                      <div key={cat.title}>
                        <button
                          onClick={() => toggleGroup(catId)}
                          className={`ml-[9px] flex w-[calc(100%-9px)] items-center gap-1.5 rounded-[6px] px-[9px] py-1 text-[11.5px] font-semibold hover:bg-white/[0.06] ${
                            highlight ? "text-[#f9fafb]" : "text-text-disabled"
                          }`}
                        >
                          <span className="w-[7px] text-center font-mono text-[10px]">{catOpen ? "−" : "+"}</span>
                          {cat.title}
                        </button>
                        {catOpen &&
                          cat.views.map((view) => (
                            <ViewRow key={view.slug} clientId={clientId} view={view} active={view.slug === activeSlug} depth={3} onSelect={onViewSelected} />
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-white/[0.08] px-4 py-3 text-[11.5px] text-text-disabled">ci@chazif.com</div>
    </aside>
  );
}
