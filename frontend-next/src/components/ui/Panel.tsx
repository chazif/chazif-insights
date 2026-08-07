import type { ReactNode } from "react";

export function Panel({ title, sub, children, className = "" }: { title?: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-[10px] border border-border p-4 ${className}`}>
      {title && (
        <div className="mb-3 flex items-baseline gap-2">
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {sub && <span className="text-[12px] text-text-muted">{sub}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
