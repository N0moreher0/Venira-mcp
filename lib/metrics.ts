/**
 * Metrics tối giản trong bộ nhớ: p50/p95/max theo từng operation.
 * Ring buffer 256 mẫu/op đủ để project_health phản ánh phiên hiện tại mà
 * không giữ lịch sử vô hạn.
 */
const MAX_SAMPLES = 256;

type Sample = { ms: number; ok: boolean };

const samples = new Map<string, Sample[]>();
const totals = { count: 0, errors: 0 };

export function recordMetric(operation: string, ms: number, ok: boolean): void {
  totals.count += 1;
  if (!ok) totals.errors += 1;
  let list = samples.get(operation);
  if (!list) {
    list = [];
    samples.set(operation, list);
  }
  list.push({ ms, ok });
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
}

const percentile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return Math.round(sorted[index] * 100) / 100;
};

export type OpMetrics = {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
  last_ms: number;
};

export function metricsSnapshot(): {
  totals: { count: number; errors: number; error_rate: number };
  operations: Record<string, OpMetrics>;
} {
  const operations: Record<string, OpMetrics> = {};
  for (const [operation, list] of samples) {
    const times = list.map((sample) => sample.ms).sort((a, b) => a - b);
    const errors = list.reduce((sum, sample) => sum + (sample.ok ? 0 : 1), 0);
    const avg = times.reduce((sum, ms) => sum + ms, 0) / times.length;
    operations[operation] = {
      count: list.length,
      errors,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      max: percentile(times, 1),
      avg: Math.round(avg * 100) / 100,
      last_ms: Math.round(list[list.length - 1].ms * 100) / 100,
    };
  }
  return {
    totals: {
      count: totals.count,
      errors: totals.errors,
      error_rate: totals.count === 0 ? 0 : Math.round((totals.errors / totals.count) * 1000) / 1000,
    },
    operations,
  };
}
