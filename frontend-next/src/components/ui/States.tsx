export const Loading = () => (
  <div className="grid h-[60vh] place-items-center text-[12.5px] text-text-disabled">Loading…</div>
);

export const ErrorState = ({ msg }: { msg: string }) => (
  <div className="grid h-[60vh] place-items-center text-[12.5px] text-negative">Error: {msg}</div>
);

export const Empty = ({ what = "No data for this client." }: { what?: string }) => (
  <div className="grid h-[60vh] place-items-center text-[12.5px] text-text-disabled">{what}</div>
);
