import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "../../lib/types";
import { money, num, moneyCompact } from "../../lib/format";

// Dual-axis: Spend (left, ink) + Main Conversions (right). `convStroke` defaults to
// warning-amber; the Overview passes accent-lime (#cfff04) + spendArea + showDots to mirror
// the original app's overview chart — a deliberate, screen-scoped exception to the
// "lime = interactive only" rule (other screens keep the amber line).
export function TrendChart({
  data,
  height = 260,
  convStroke = "#b45309",
  convWidth = 1.6,
  showDots = false,
  spendArea = false,
}: {
  data: TrendPoint[];
  height?: number;
  convStroke?: string;
  convWidth?: number;
  showDots?: boolean;
  spendArea?: boolean;
}) {
  const inkDot: false | { r: number; fill: string; stroke: string } =
    showDots ? { r: 2, fill: "#1a1a1a", stroke: "#1a1a1a" } : false;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#f3f4f6" vertical={false} />
        <XAxis dataKey="Month" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={16} />
        <YAxis yAxisId="left" width={52} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => moneyCompact(v)} />
        <YAxis yAxisId="right" orientation="right" width={44} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => num(v, 0)} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, fontFamily: "Instrument Sans" }}
          labelStyle={{ color: "#6b7280", fontSize: 11 }}
          formatter={(value: number, name: string) => [name === "Spend" ? money(value) : num(value, 0), name]}
        />
        {spendArea ? (
          <Area yAxisId="left" type="monotone" dataKey="Spend" stroke="#1a1a1a" strokeWidth={2} fill="rgba(26,26,26,0.06)" dot={inkDot} activeDot={{ r: 3 }} />
        ) : (
          <Line yAxisId="left" type="monotone" dataKey="Spend" stroke="#1a1a1a" strokeWidth={1.6} dot={false} />
        )}
        <Line yAxisId="right" type="monotone" dataKey="Main Conv" stroke={convStroke} strokeWidth={convWidth} dot={inkDot} activeDot={{ r: 3 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
