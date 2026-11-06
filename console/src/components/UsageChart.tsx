import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dayLabel, num, usd } from '@/lib/format';

export type UsageDay = { day: string; calls: number; cost_usd: number; credits: number };

/** Custo de IA por dia (barras), no padrão de gráficos dos produtos. */
export function UsageChart({ data, height = 220 }: { data: UsageDay[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, label: dayLabel(d.day), cost: Number(d.cost_usd) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--text-muted))' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--text-muted))' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `$${Number(v).toFixed(2)}`} />
        <Tooltip
          cursor={{ fill: 'hsl(var(--primary) / 0.06)' }}
          contentStyle={{ borderRadius: 10, border: '1px solid hsl(var(--border))', fontSize: 12 }}
          formatter={(v: number, _n, p) => [`${usd(v)} · ${num(p.payload.calls)} uso(s) · ${num(p.payload.credits, 1)} créditos`, 'Custo']}
        />
        <Bar dataKey="cost" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}
