import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { metricStages, observationStages, qualityReport } from '../apps/api/src/metrics.js';

export const demoCases = ['book', 'correct_time', 'interrupt', 'early_confirmation', 'refresh_after_offer',
  'refresh_after_selection', 'taken_selection', 'confirmed_request_not_sent', 'lost_response',
  'reconnect_after_confirmation', 'reschedule', 'last_slot_conflict', 'misheard_detail', 'missing_worker', 'speech_failure'] as const;
const nonempty = z.string().trim().min(1).max(160);
const milliseconds = z.number().finite().min(0).max(3600000);
const summary = z.object({ samples: z.number().int().nonnegative(), errors: z.number().int().nonnegative(),
  latestMs: milliseconds.nullable(), p50Ms: milliseconds.nullable(), p95Ms: milliseconds.nullable() }).strict();
const qualitySchema = z.object({
  generatedAt: z.iso.datetime(), timezone: nonempty, windowLimit: z.literal(100), eventCount: z.number().int().min(0).max(100),
  latency: z.array(z.object({ stage: z.enum(['audible_reply', 'interruption', 'booking_api']), samples: z.number().int().nonnegative(),
    p50Ms: milliseconds.nullable(), p95Ms: milliseconds.nullable(), targets: z.object({ p50Ms: milliseconds.nullable(), p95Ms: milliseconds.nullable() }).strict(),
    estimated: z.boolean(), assessment: z.enum(['not_measured', 'estimate_within_target', 'estimate_above_target', 'within_target', 'above_target']) }).strict()).length(3),
  observations: z.object({ falseInterruptions: z.number().int().nonnegative(), sttCorrections: z.number().int().nonnegative(),
    toolErrors: z.number().int().nonnegative(), reconnects: z.number().int().nonnegative(), reconnectErrors: z.number().int().nonnegative() }).strict(),
  stages: z.record(z.enum(metricStages.filter((stage) => !observationStages.some((observation) => observation === stage))), summary),
  // Rebuild explanatory prose locally; never copy arbitrary source text to artifacts.
  limitations: z.array(z.string()).max(20),
}).strict();
const caseSchema = z.object({ status: z.enum(['pass', 'fail', 'not_run']), method: z.enum(['live_voice', 'automated', 'not_run']) }).strict()
  .refine((item) => (item.status === 'not_run') === (item.method === 'not_run'), { message: 'Unrun cases must use the not_run method' });
const contextSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  setup: z.object({ stt: nonempty.nullable(), llm: nonempty.nullable(), tts: nonempty.nullable(), voice: nonempty.nullable(),
    browser: nonempty.nullable(), os: nonempty.nullable(), network: nonempty.nullable() }).strict(),
  scenarios: z.record(z.enum(demoCases), caseSchema),
}).strict();

export function buildDemoRun(metrics: unknown, context: unknown) {
  const snapshot = qualitySchema.parse(metrics);
  const run = contextSchema.parse(context);
  // Assess target comparisons from numeric samples, not imported assessment labels.
  const canonical = qualityReport([]);
  const latency = canonical.latency.map((target) => {
    const stage = snapshot.stages[target.stage];
    if ((stage.samples === 0) !== (stage.p50Ms === null && stage.p95Ms === null)
      || (stage.samples > 0 && (stage.p50Ms === null || stage.p95Ms === null || stage.p50Ms > stage.p95Ms))) {
      throw new Error('Inconsistent latency samples');
    }
    const within = stage.samples > 0 && (target.targets.p50Ms === null || stage.p50Ms! <= target.targets.p50Ms)
      && (target.targets.p95Ms === null || stage.p95Ms! <= target.targets.p95Ms);
    return { ...target, samples: stage.samples, p50Ms: stage.p50Ms, p95Ms: stage.p95Ms,
      assessment: stage.samples === 0 ? 'not_measured' : target.estimated
        ? within ? 'estimate_within_target' : 'estimate_above_target' : within ? 'within_target' : 'above_target' };
  });
  const stages = snapshot.stages;
  const missingSetup = Object.entries(run.setup).filter(([, value]) => value === null).map(([key]) => key);
  const pendingCases = demoCases.filter((name) => run.scenarios[name].status === 'not_run');
  const failedCases = demoCases.filter((name) => run.scenarios[name].status === 'fail');
  const liveRequired = ['book', 'correct_time', 'interrupt', 'early_confirmation', 'refresh_after_offer', 'refresh_after_selection', 'reconnect_after_confirmation', 'reschedule'] as const;
  const missingLiveChecks = liveRequired.filter((name) => run.scenarios[name].status !== 'pass' || run.scenarios[name].method !== 'live_voice');
  return { ...run, generatedAt: snapshot.generatedAt, timezone: snapshot.timezone,
    evidence: 'Scenario results are tester-reported, not verified by this report tool.',
    metrics: { windowLimit: snapshot.windowLimit, eventCount: snapshot.eventCount, latency, observations: {
      falseInterruptions: snapshot.observations.falseInterruptions, sttCorrections: snapshot.observations.sttCorrections,
      toolErrors: stages.booking_api.errors, reconnects: stages.reconnect.samples, reconnectErrors: stages.reconnect.errors,
    }, stages, limitations: canonical.limitations },
    remaining: { missingSetup, pendingCases, failedCases, missingLiveChecks,
      audibleLatencyVerification: 'A consented test recording is still required to verify browser estimates.' },
  };
}

export function demoRunMarkdown(run: ReturnType<typeof buildDemoRun>) {
  const cell = (value: unknown) => String(value ?? 'Not recorded').replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
  const lines = [`# VoiceAI demo run: ${run.runId}`, '', `Snapshot: ${run.generatedAt} · ${cell(run.timezone)}`, '', run.evidence, '',
    '## Setup', '', '| Field | Value |', '| --- | --- |', ...Object.entries(run.setup).map(([key, value]) => `| ${key} | ${cell(value)} |`), '',
    '## Scenarios', '', '| Case | Result | Method |', '| --- | --- | --- |',
    ...demoCases.map((name) => `| ${name} | ${run.scenarios[name].status} | ${run.scenarios[name].method} |`), '',
    '## Latency targets', '', '| Stage | Samples | p50 ms | p95 ms | Comparison |', '| --- | --- | --- | --- | --- |',
    ...run.metrics.latency.map((item) => `| ${item.stage} | ${item.samples} | ${item.p50Ms ?? '—'} | ${item.p95Ms ?? '—'} | ${item.assessment} |`), '',
    '## Observations', '', ...Object.entries(run.metrics.observations).map(([name, count]) => `- ${name}: ${count}`), '',
    '## Remaining verification', '', `- Missing setup: ${run.remaining.missingSetup.join(', ') || 'none'}`,
    `- Unrun cases: ${run.remaining.pendingCases.join(', ') || 'none'}`, `- Failed cases: ${run.remaining.failedCases.join(', ') || 'none'}`,
    `- Missing live checks: ${run.remaining.missingLiveChecks.join(', ') || 'none'}`, `- ${run.remaining.audibleLatencyVerification}`, '',
    '## Measurement limits', '', ...run.metrics.limitations.map((limit) => `- ${limit}`), ''];
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { metrics: { type: 'string' }, context: { type: 'string' }, output: { type: 'string' } } });
  if (!values.metrics || !values.context) throw new Error('Usage: npm run demo:report -- --metrics <quality.json> --context <run-context.json> [--output <directory>]');
  const [metrics, context] = await Promise.all([readFile(values.metrics, 'utf8'), readFile(values.context, 'utf8')]);
  const run = buildDemoRun(JSON.parse(metrics), JSON.parse(context));
  const directory = resolve(values.output ?? '.data/quality/runs');
  const jsonPath = resolve(directory, `${run.runId}.json`);
  const markdownPath = resolve(directory, `${run.runId}.md`);
  await mkdir(dirname(jsonPath), { recursive: true });
  // Exclusive creation protects an earlier run from being overwritten accidentally.
  await writeFile(jsonPath, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' });
  await writeFile(markdownPath, demoRunMarkdown(run), { flag: 'wx' });
  console.log(`Saved ${jsonPath}\nSaved ${markdownPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Do not echo imported values: malformed input might contain private data.
    console.error(error instanceof z.ZodError ? 'Invalid report or context schema. Check DEMO.md and tools/demo-run.example.json.'
      : (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'Run already exists. Choose a new runId.'
      : error instanceof SyntaxError ? 'Input must be valid JSON.'
      : error instanceof Error && ['Usage:', 'Inconsistent latency'].some((prefix) => error.message.startsWith(prefix)) ? error.message
      : 'Could not create demo report. Check input files and output directory.');
    process.exitCode = 1;
  });
}
