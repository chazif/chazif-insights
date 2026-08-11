export function FilterInput({ value, onChange, placeholder = "Filter…" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="min-w-[220px] rounded-[7px] border border-border-strong px-2.5 py-1 text-[12.5px] outline-none focus:border-accent"
    />
  );
}
