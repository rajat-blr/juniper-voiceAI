export const observationStages = ['false_interruption', 'stt_correction'] as const;
export const metricStages = ['booking_api', 'reconnect', 'stt', 'turn_detection', 'model', 'tts', 'audible_reply', 'interruption', 'connection', ...observationStages] as const;
export type MetricStage = typeof metricStages[number];
export interface MetricEvent {
  stage: MetricStage;
  duration_ms: number;
  result: 'ok' | 'error';
  created_at: string;
}
export interface StageSummary {
  samples: number;
  errors: number;
  latestMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}
export function summarizeMetrics(events: MetricEvent[]): Record<MetricStage, StageSummary> {
  return Object.fromEntries(metricStages.map((stage) => {
    const matching = events.filter((event) => event.stage === stage);
    // Failures may have no measured duration. Never mix them into latency percentiles.
    const successes = matching.filter((event) => event.result === 'ok');
    const sorted = successes.map((event) => event.duration_ms).sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    return [stage, { samples: successes.length, errors: matching.filter((event) => event.result === 'error').length,
      latestMs: successes[0]?.duration_ms ?? null, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }];
  })) as Record<MetricStage, StageSummary>;
}
export function metricsCsv(events: MetricEvent[]) {
  // Export only numeric telemetry and allowlisted enums, never tokens or transcripts.
  const cell = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  return ['stage,duration_ms,result,created_at', ...events.map((event) =>
    [event.stage, event.duration_ms, event.result, event.created_at].map(cell).join(','))].join('\r\n') + '\r\n';
}

export function qualityReport(events: MetricEvent[]) {
  const summary = summarizeMetrics(events);
  const target = (stage: MetricStage, p50Ms: number | null, p95Ms: number | null, estimated: boolean) => {
    const measured = summary[stage];
    const hasSamples = measured.samples > 0;
    const withinTarget = hasSamples && (p50Ms === null || measured.p50Ms! <= p50Ms)
      && (p95Ms === null || measured.p95Ms! <= p95Ms);
    return { stage, samples: measured.samples, p50Ms: measured.p50Ms, p95Ms: measured.p95Ms,
      targets: { p50Ms, p95Ms }, estimated,
      assessment: !hasSamples ? 'not_measured' : estimated
        ? withinTarget ? 'estimate_within_target' : 'estimate_above_target'
        : withinTarget ? 'within_target' : 'above_target' };
  };
  return {
    windowLimit: 100, eventCount: events.length,
    latency: [target('audible_reply', 1200, 2500, true), target('interruption', 350, null, true), target('booking_api', null, 300, false)],
    observations: { falseInterruptions: summary.false_interruption.samples, sttCorrections: summary.stt_correction.samples,
      toolErrors: summary.booking_api.errors, reconnects: summary.reconnect.samples, reconnectErrors: summary.reconnect.errors },
    stages: Object.fromEntries(metricStages.filter((stage) => !observationStages.some((observation) => observation === stage)).map((stage) => [stage, summary[stage]])),
    limitations: ['Latest 100 session events, not a complete test-run history.',
      'Browser audio estimates do not verify audible latency targets.',
      'False interruptions and STT corrections are marked manually by the tester.',
      'Small sample counts do not establish a stable p95. Stage percentiles cannot be added together.',
      'Record actual models, browser, operating system, network, and scripted cases separately in DEMO.md.'],
  };
}
