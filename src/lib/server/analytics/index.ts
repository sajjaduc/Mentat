/**
 * Analytics barrel.
 *
 * `query` is the widget engine, `funnel` and `aging` are the history-derived
 * reports, `series`/`stats` are the shared math, and `dashboards` owns the
 * persistence and orchestration around widgets. Everything here compiles its
 * filters through `filters/compile`, so widgets and lists cannot disagree.
 */
export * from './aging';
export * from './dashboards';
export * from './funnel';
export * from './query';
export * from './series';
export * from './stats';
