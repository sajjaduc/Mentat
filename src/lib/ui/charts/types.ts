/**
 * Chart data shapes.
 *
 * A chart consumes `ChartDatum[]` per series. Keeping these in a `.ts` module
 * (rather than in the Svelte component's module script) means a page can type its
 * transformed widget data without importing a component, and the chart components
 * share one definition of what a datum is.
 */

export interface ChartDatum {
  label: string;
  value: number;
  /** Original label with no truncation, kept for tooltips and the data table. */
  rawLabel?: string;
}

export interface ChartSeries {
  name: string;
  data: ChartDatum[];
}
