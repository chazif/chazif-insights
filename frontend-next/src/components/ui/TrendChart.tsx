import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "../../lib/types";
import { money, num, moneyCompact } from "../../lib/format";

// Dual-axis line: Spend (left, ink) + Main Conversions (right, amber). No lime — lime is
// reserved for interactive elements, never a data series.
export function TrendChart({ data, height = 260 }: { data: TrendPoint[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#f3f4f6" vertical={false} />
        <XAxis dataKey="Month" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={16} />
        <YAxis yAxisId="left" width={52} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => moneyCompact(v)} />
        <YAxis yAxisId="right" orientation="right" width={44} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => num(v, 0)} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, fontFamily: "Instrument Sans" }}
          labelStyle={{ color: "#6b7280", fontSize: 11 }}
          formatter={(value: number, name: string) => [name === "Spend" ? money(value) : num(value, 0), name]}
        />
        <Line yAxisId="left" type="monotone" dataKey="Spend" stroke="#1a1a1a" strokeWidth={1.6} dot={false} />
        <Line yAxisId="right" type="monotone" dataKey="Main Conv" stroke="#b45309" strokeWidth={1.6} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
