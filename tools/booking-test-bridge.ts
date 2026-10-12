// Isolated API contract bridge for Python tool integration tests. No sockets,
// project credentials, cloud inference, or persistent demo data are used.
import { createInterface } from 'node:readline';
import { DateTime } from 'luxon';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';

const db = await openDatabase();
const { app } = await buildApp(db, { clock: () => DateTime.fromISO('2026-10-11T00:00:00Z') });
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.shutdown) break;
    const response = await app.inject({ method: request.method, url: request.path,
      headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
      ...(request.payload !== null && request.payload !== undefined ? { payload: request.payload } : {}) });
    process.stdout.write(JSON.stringify({ statusCode: response.statusCode, body: response.json() }) + '\n');
  }
} finally { await app.close(); await db.close(); }
