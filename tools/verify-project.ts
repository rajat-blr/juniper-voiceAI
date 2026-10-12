import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function check(name: string, command: string, args: string[]) {
  const start = performance.now();
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const exitCode = await new Promise<number>((done, reject) => {
    child.once('error', reject); child.once('close', (code) => done(code ?? 1));
  });
  if (exitCode !== 0) {
    // Test fixtures are synthetic; still redact bearer values from failure output.
    console.error(output.replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted token]').replace(/Bearer\s+[A-Za-z0-9_-]+/g, 'Bearer [redacted]').slice(-6000));
    throw new Error(`${name} failed`);
  }
  const tests = Number(output.match(/(?:ℹ |# )?tests (\d+)/)?.[1] ?? output.match(/Ran (\d+) tests?/)?.[1] ?? 0);
  console.log(`${name}: passed${tests ? ` (${tests} tests)` : ''}`);
  return { name, status: 'passed', tests, elapsedMs: Math.round(performance.now() - start) };
}

async function main() {
  const { values } = parseArgs({ options: { http: { type: 'boolean', default: false } } });
  console.log('Running build, TypeScript checks, and Python voice-tool checks. No cloud inference.');
  const tests = await Promise.all([
    check('Build and TypeScript', 'npm', ['run', 'check']),
    check('Python receptionist', resolve(root, 'apps/agent/.venv/bin/python'), ['-m', 'unittest', 'discover', '-s', 'apps/agent/tests', '-v']),
  ]);
  if (tests.some((item) => item.tests === 0)) throw new Error('Test counts unavailable; verification cannot be marked complete');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(root, '.data/verification', runId);
  await mkdir(directory, { recursive: true });
  const benchmarkPath = resolve(directory, 'api-benchmark.json');
  const transport = values.http ? 'http' : 'inject';
  console.log(`Running isolated API benchmark (${transport}, 40 booking and 40 reschedule samples after warmup).`);
  await check('API benchmark', 'npm', ['run', 'benchmark:api', '--', '--transport', transport, '--output', benchmarkPath]);
  const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
  const report = { generatedAt: new Date().toISOString(), tests, benchmark,
    releaseReady: false,
    remaining: ['Live voice rescheduling and recovery at all checkpoints.',
      'Controlled audible-latency test with actual model/browser/network context.',
      'Consented synthetic portfolio recording.',
      'Standalone PostgreSQL pool/concurrency verification if presenting that deployment mode.',
      ...(values.http ? [] : ['HTTP round-trip benchmark; the injected benchmark excludes network.'])] };
  await writeFile(resolve(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const milliseconds = (value: number) => `${value.toFixed(1)} ms`;
  const markdown = ['# VoiceAI verification', '', `Generated: ${report.generatedAt}`, '',
    ...tests.map((item) => `- ${item.name}: passed, ${item.tests} tests.`), '',
    '## API baseline', '', `Transport: ${transport}. Database: isolated in-memory PGlite. Five warmup iterations excluded.`, '',
    '| Stage | Samples | p50 | p95 |', '| --- | --- | --- | --- |',
    ...Object.entries(benchmark.stages).map(([stage, item]) => { const row = item as { samples: number; p50Ms: number; p95Ms: number }; return `| ${stage} | ${row.samples} | ${milliseconds(row.p50Ms)} | ${milliseconds(row.p95Ms)} |`; }), '',
    `Target assessment: ${benchmark.targetAssessment}.`, '',
    'Booking, rescheduling, retry, restored-state, and slot-race invariants passed in the isolated benchmark.', '',
    ...benchmark.limitations.map((limit: string) => `- ${limit}`), '',
    '## Remaining before release', '', ...report.remaining.map((item) => `- ${item}`), '',
    'This automated run does not verify cloud speech or certify release readiness.', ''].join('\n');
  const summaryPath = resolve(directory, 'verification.md');
  await writeFile(summaryPath, markdown, { flag: 'wx' });
  await writeFile(resolve(root, '.data/verification/latest.json'), JSON.stringify({ report: summaryPath, data: resolve(directory, 'verification.json') }, null, 2) + '\n');
  console.log(`Verification saved: ${summaryPath}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Verification failed'); process.exitCode = 1; });
