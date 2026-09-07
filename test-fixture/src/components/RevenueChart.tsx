import React, { memo } from "react";
import { createSeries } from "@/config";
import { SeriesKind, SeriesRegistry } from "@/utils/series";

interface RevenueChartProps {
  metric: "revenue" | "units";
  area?: boolean;
}

export const RevenueChart = memo(function RevenueChart({ metric, area }: RevenueChartProps) {
  const series = createSeries(metric, area ? SeriesKind.Area : SeriesKind.Line);
  SeriesRegistry.shared.add(series);
  return <ChartCanvas color={series.color} width={series.strokeWidth} />;
});

export function ChartCanvas({ color, width }: { color: string; width: number }) {
  return <svg data-color={color} data-width={width} />;
}

export default RevenueChart;
