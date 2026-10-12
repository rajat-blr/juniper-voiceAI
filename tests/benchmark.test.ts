import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkApi } from '../tools/benchmark-api.js';

test('isolated API benchmark checks writes and retries without claiming an HTTP latency result', async () => {
  const report = await benchmarkApi({ samples: 3, warmups: 1, transport: 'inject' });
  assert.equal(report.targetAssessment, 'not_assessed_network_excluded');
  assert.equal(report.invariants.appointments, 5);
  assert.ok(Object.values(report.invariants).every(Boolean));
  for (const stage of Object.values(report.stages)) {
    assert.equal(stage.samples, 3); assert.ok(stage.p50Ms >= 0); assert.ok(stage.p95Ms >= stage.p50Ms);
  }
  assert.equal(JSON.stringify(report).includes('Benchmark Demo'), false);
  assert.equal(JSON.stringify(report).includes('operationId'), false);
});
