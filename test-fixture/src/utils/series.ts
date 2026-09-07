import { METRIC_SERIES_COLORS, PRIMARY_SERIES_FILL_OPACITY } from "@/config/colors";

export interface SeriesConfig {
  name: string;
  color: string;
  strokeWidth: number;
  fillOpacity?: number;
}

export enum SeriesKind {
  Line = "line",
  Area = "area",
}

export type MetricKey = keyof typeof METRIC_SERIES_COLORS;

/** Builds the primary series for a metric. */
export function buildSeries(metric: MetricKey, kind: SeriesKind = SeriesKind.Line): SeriesConfig {
  return {
    name: metric,
    color: METRIC_SERIES_COLORS[metric],
    strokeWidth: 1,
    fillOpacity: kind === SeriesKind.Area ? PRIMARY_SERIES_FILL_OPACITY : undefined,
  };
}

export const buildCompareSeries = (metric: MetricKey): SeriesConfig => ({
  ...buildSeries(metric),
  strokeWidth: 1,
});

let seriesCounter = 0;
export function nextSeriesId(): number {
  seriesCounter += 1;
  return seriesCounter;
}

export class SeriesRegistry {
  private items: SeriesConfig[] = [];
  static shared = new SeriesRegistry();
  add(cfg: SeriesConfig): void {
    this.items.push(cfg);
  }
  get count(): number {
    return this.items.length;
  }
}

export class NamedRegistry extends SeriesRegistry {
  label = "named";
}
