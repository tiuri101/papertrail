import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

interface BarDatum {
  label: string
  count: number
}

const axisTick = { fill: 'var(--color-text-muted)', fontSize: 12 }
const categoryTick = { fill: 'var(--color-text-secondary)', fontSize: 12 }
const axisLine = { stroke: 'var(--color-border)' }

export function FieldBarChart({
  data,
  orientation,
  height,
}: {
  data: BarDatum[]
  orientation: 'horizontal' | 'vertical'
  height?: number
}) {
  if (data.length === 0) return null
  const isHorizontal = orientation === 'horizontal'
  const chartHeight = height ?? (isHorizontal ? Math.max(120, data.length * 36) : 220)

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        data={data}
        layout={isHorizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 28, bottom: 8, left: 8 }}
      >
        <CartesianGrid
          stroke="var(--color-border)"
          horizontal={!isHorizontal}
          vertical={isHorizontal}
        />
        {isHorizontal ? (
          <>
            <XAxis
              type="number"
              allowDecimals={false}
              tick={axisTick}
              axisLine={axisLine}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={140}
              tick={categoryTick}
              axisLine={axisLine}
              tickLine={false}
            />
          </>
        ) : (
          <>
            <XAxis dataKey="label" tick={categoryTick} axisLine={axisLine} tickLine={false} />
            <YAxis type="number" allowDecimals={false} tick={axisTick} axisLine={axisLine} tickLine={false} />
          </>
        )}
        <Tooltip
          cursor={{ fill: 'var(--color-surface-hover)' }}
          contentStyle={{
            background: 'var(--color-surface-raised)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-text)',
          }}
          labelStyle={{ color: 'var(--color-text-secondary)' }}
        />
        <Bar
          dataKey="count"
          fill="var(--color-primary)"
          barSize={20}
          radius={isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
        >
          <LabelList
            dataKey="count"
            position={isHorizontal ? 'right' : 'top'}
            fill="var(--color-text-secondary)"
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
