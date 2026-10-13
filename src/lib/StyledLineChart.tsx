import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Label,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const _CHART_COLOR = "#34FA69";

export type ChartTheme = "light" | "dark";

// Converts a CSS color token such as "  247 247 247" to "#f7f7f7".
// Computed custom properties can include leading whitespace.
export const rgbToHex = (rgb: string) => {
  const hex = rgb
    .trim()
    .split(/\s+/)
    .map((value) => Number(value).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
};

// Reads the app's Tailwind theme tokens, which change with `theme`.
const useThemeValues = (theme: ChartTheme) => {
  return useMemo(() => {
    const computedStyles = window.getComputedStyle(
      document.documentElement
    );

    const hex = (key: string) =>
      rgbToHex(computedStyles.getPropertyValue(key));

    return { hex };
  }, [theme]);
};

export enum Metric {
  revenue = "revenue",
  transactions = "transactions",
}

const metricToStringRecord: Record<Metric, string> = {
  [Metric.revenue]: "Revenue",
  [Metric.transactions]: "Transactions",
};

export interface ChartProps {
  metric: Metric;
  data: [{ name: string; revenue: number; transactions: number }];
  xlabel: string;
  ylabel?: string;
  theme: ChartTheme;
}

const numberFormatter = Intl.NumberFormat("en-US", {
  notation: "compact",
});

const formatMetricValue = (value: number, metric: Metric) => {
  const formattedValue = numberFormatter
    .format(value)
    .replace("K", "k");
  return addMetricUnit(formattedValue, metric);
};

const addMetricUnit = <T,>(value: T, metric: Metric) =>
  metric === Metric.revenue ? `$${value}` : value;

const formatTooltipValue = (value: number, metric: Metric) => {
  if (metric === Metric.revenue) {
    // Show sub-cent payments (e.g. $0.005) rather than rounding
    // them, matching the payment history list.
    return value < 0.01 && value > 0
      ? `$${value.toFixed(6).replace(/\.?0+$/, "")}`
      : `$${value.toFixed(2)}`;
  }
  return value;
};

export const StyledLineChart = ({
  metric,
  data,
  xlabel,
  ylabel,
  theme,
}: ChartProps) => {
  const themeValues = useThemeValues(theme);
  const [strokeColor, setStrokeColor] = useState<string>(
    themeValues.hex("--surface-primary")
  );
  const [fillColor, setFillColor] = useState<string>(
    themeValues.hex("--surface-tertiary")
  );

  useEffect(() => {
    setStrokeColor(themeValues.hex("--surface-primary"));
    setFillColor(
      theme === "dark"
        ? "#171717"
        : themeValues.hex("--surface-tertiary")
    );
  }, [theme, themeValues]);

  return (
    <div className="h-[400px] [&_.recharts-cartesian-axis-tick]:text-b2 [&_.recharts-cartesian-axis-tick-value]:!fill-foreground-primary [&_.recharts-cartesian-axis-tick-value]:!font-medium [&_.recharts-text.recharts-label]:!fill-foreground-primary">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{
            top: 0,
            right: 0,
            left: 0,
            bottom: 0,
          }}
        >
          <defs>
            <linearGradient
              id="colorUv"
              x1="0"
              y1="0"
              x2="0"
              y2="340"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor={_CHART_COLOR} />
              <stop
                stopColor={_CHART_COLOR}
                offset="1"
                stopOpacity="0.1"
              />
            </linearGradient>
          </defs>
          <Tooltip
            wrapperClassName="!bg-red-500 !bg-surface-primary !text-b2 !text-foreground-primary !border-border-primary !rounded-xl [&_.recharts-tooltip-item-value]:!font-medium"
            labelClassName="!text-b1 !font-medium"
            labelFormatter={(label) => label}
            formatter={(value) => [
              formatTooltipValue(value as number, metric),
              metricToStringRecord[metric],
            ]}
            itemStyle={{
              color: "currentcolor",
            }}
            separator=": "
          />
          <CartesianGrid
            horizontal={false}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={8}
          />
          <XAxis
            axisLine={false}
            dataKey="name"
            tickLine={false}
            height={75}
          >
            <Label
              style={{
                textAnchor: "middle",
                fontSize: "75%",
              }}
              angle={0}
              value={xlabel}
              dy={20}
            />
          </XAxis>
          <YAxis
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) =>
              formatMetricValue(value, metric)
            }
          >
            {ylabel && (
              <Label
                style={{
                  textAnchor: "middle",
                  fontSize: "75%",
                }}
                angle={-90}
                value={ylabel}
                position="insideLeft"
              />
            )}
          </YAxis>
          <Area
            stroke={
              theme === "dark" ? themeValues.hex("--primary") : "none"
            }
            isAnimationActive={false}
            type="linear"
            dataKey={metric}
            fill="url(#colorUv)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};
