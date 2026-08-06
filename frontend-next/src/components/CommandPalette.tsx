import { useEffect } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { NAV, breadcrumb, type ViewDef } from "../nav/model";

// ⌘K command palette. Searches views (actions/campaigns/keywords join later). Escape or a
// scrim click closes; selecting a view navigates and closes.
export function CommandPalette({ open, onClose, clientId }: { open: boolean; onClose: () => void; clientId: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const views: ViewDef[] = [];
  for (const job of NAV) {
    for (const v of job.views ?? []) views.push(v);
    for (const c of job.categories ?? []) for (const v of c.views) views.push(v);
  }
  const go = (slug: string) => {
    onClose();
    navigate(`/c/${clientId}/${slug}`);
  };

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-[rgba(26,26,26,0.34)]" onClick={onClose} />
      <div className="absolute left-1/2 top-[12vh] w-[min(600px,90vw)] -translate-x-1/2 overflow-hidden rounded-[12px] bg-surface shadow-[0_24px_64px_rgba(26,26,26,0.28)]">
        <Command label="Command palette" loop>
          <Command.Input
            autoFocus
            placeholder="Jump to a view, campaign, keyword or action…"
            className="w-full border-b border-border px-4 py-3 text-[15px] outline-none placeholder:text-text-disabled"
          />
          <Command.List className="max-h-[52vh] overflow-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-[12.5px] text-text-disabled">No results.</Command.Empty>
            <Command.Group heading="Views" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-text-muted">
              {views.map((v) => (
                <Command.Item
                  key={v.slug}
                  value={`${v.title} ${breadcrumb(v.slug)}`}
                  onSelect={() => go(v.slug)}
                  className="flex cursor-pointer items-center gap-3 rounded-[7px] px-3 py-2 text-[13px] data-[selected=true]:bg-row-hover"
                >
                  <span className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">View</span>
                  <span className="font-medium">{v.title}</span>
                  <span className="ml-auto text-[12px] italic text-text-muted">{breadcrumb(v.slug)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
