import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// Validated categorical order (blue, orange, aqua); gridlines recessive; text uses ink tokens, not series colors.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const AXIS = { fontSize: 12, fill: '#566774' };

function Tip({ active, payload, label, formatters }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold">{label ?? payload[0].payload.name}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="size-2 rounded-sm" style={{ background: p.color || p.payload.fill }} aria-hidden="true" />
          <span className="text-muted">{p.name}</span>
          <span className="ml-auto pl-3 font-semibold num">{(formatters && formatters[p.dataKey] ? formatters[p.dataKey](p.value) : p.value)}</span>
        </p>
      ))}
    </div>
  );
}

const compact = (v) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v);

/** series: [{ key, name, format }]. Legend appears for 2+ series; one series is named by the card title. */
export function TrendChart({ data, xKey = 'label', series, variant = 'area', height = 260, yFormat = compact }) {
  const formatters = Object.fromEntries(series.map((s) => [s.key, s.format || ((v) => v)]));
  const common = { data, margin: { top: 8, right: 8, left: -8, bottom: 0 } };
  const axes = (
    <>
      <CartesianGrid stroke="#e3e9ee" vertical={false} />
      <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: '#cfd8df' }} minTickGap={24} />
      <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={yFormat} width={48} />
      <Tooltip content={<Tip formatters={formatters} />} cursor={{ stroke: '#9fb0bc', strokeDasharray: '3 3' }} />
      {series.length > 1 && <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingBottom: 8 }} />}
    </>
  );
  return (
    <div style={{ height }} role="img" aria-label={`${series.map((s) => s.name).join(' and ')} chart`}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'bar' ? (
          <BarChart {...common}>{axes}
            {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={SERIES[i]} radius={[4, 4, 0, 0]} maxBarSize={28} />)}
          </BarChart>
        ) : variant === 'line' ? (
          <LineChart {...common}>{axes}
            {series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />)}
          </LineChart>
        ) : (
          <AreaChart {...common}>
            <defs>{series.map((s, i) => (
              <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES[i]} stopOpacity=".22" /><stop offset="100%" stopColor={SERIES[i]} stopOpacity="0" /></linearGradient>
            ))}</defs>
            {axes}
            {series.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i]} strokeWidth={2} fill={`url(#fill-${s.key})`} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />)}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal ranked bars, one colour (magnitude, not identity). */
export function RankBars({ data, nameKey = 'name', valueKey, name, format = (v) => v, height, color = SERIES[0], nameWidth = 130 }) {
  const h = height || Math.max(160, data.length * 34 + 16);
  return (
    <div style={{ height: h }} role="img" aria-label={`${name} by ${nameKey}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey={nameKey} tick={{ ...AXIS, fill: '#12222e' }} tickLine={false} axisLine={false} width={nameWidth} interval={0} />
          <Tooltip content={<Tip formatters={{ [valueKey]: format }} />} cursor={{ fill: '#eef3f6' }} />
          <Bar dataKey={valueKey} name={name} radius={[0, 4, 4, 0]} maxBarSize={20}>
            {data.map((d, i) => <Cell key={i} fill={color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
