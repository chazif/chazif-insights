import { useEffect, useState } from "react";
import { Outlet, useParams } from "react-router-dom";
import { NavRail } from "../components/NavRail";
import { ContextBar } from "../components/ContextBar";
import { CommandPalette } from "../components/CommandPalette";
import { VIEW_INDEX, DEFAULT_VIEW } from "../nav/model";
import { useMediaQuery } from "../hooks/useMediaQuery";

// The app frame: rail + context bar + routed view. Handles rail collapse/overlay (auto below
// 1100px, manual override sticks for the session), the ⌘K palette, and which nav groups are open.
export function AppShell() {
  const { clientId = "", view } = useParams();
  const activeSlug = view ?? DEFAULT_VIEW;
  const rv = VIEW_INDEX[activeSlug];

  const wide = useMediaQuery("(min-width: 1100px)");
  const [railManual, setRailManual] = useState<boolean | null>(null); // null → follow viewport
  const railOpen = railManual ?? wide;
  const narrow = !wide;
  const overlay = narrow && railOpen;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  // Auto-expand the group holding the active view (else the active item would be hidden).
  useEffect(() => {
    if (!rv) return;
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.add("job:" + rv.job.key);
      if (rv.category) next.add("cat:" + rv.job.key + "/" + rv.category.title);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug]);

  // ⌘K / Ctrl-K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandWithGroup = (jobId: string) => {
    setRailManual(true);
    setOpenGroups((prev) => new Set(prev).add(jobId));
  };

  const rail = (
    <NavRail
      clientId={clientId}
      activeSlug={activeSlug}
      open={railOpen}
      openGroups={openGroups}
      toggleGroup={toggleGroup}
      onToggleRail={() => setRailManual(!railOpen)}
      onExpandWithGroup={expandWithGroup}
      onOpenPalette={() => setPaletteOpen(true)}
      onViewSelected={() => {
        if (narrow) setRailManual(false); // overlay dismisses on selection
      }}
    />
  );

  return (
    <div className="relative flex h-screen overflow-hidden font-ui text-ink">
      {overlay ? (
        <>
          <div className="w-[56px] shrink-0" aria-hidden />
          <div className="absolute left-0 top-0 z-[30] h-full shadow-[8px_0_32px_rgba(26,26,26,0.30)]">{rail}</div>
          <div className="absolute inset-0 z-[29] bg-[rgba(26,26,26,0.34)]" onClick={() => setRailManual(false)} />
        </>
      ) : (
        rail
      )}

      <main className="flex-1 overflow-auto">
        <ContextBar view={rv} />
        <Outlet />
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} clientId={clientId} />
    </div>
  );
}
