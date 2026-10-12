import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRuntimeApplication } from '../apps/api/src/runtime.js';

let application: ReturnType<typeof createRuntimeApplication> | undefined;
export function apiPath(value: string) {
  const url = new URL(value, 'https://internal.invalid');
  const captured = url.searchParams.get('__path'); url.searchParams.delete('__path');
  const path = url.pathname.startsWith('/api/') && url.pathname !== '/api/index'
    ? url.pathname.slice(4) : captured ? '/' + captured.replace(/^\/+/, '') : '/';
  return path + (url.searchParams.size ? '?' + url.searchParams.toString() : '');
}
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  try {
    if (!application) application = createRuntimeApplication().catch((error) => { application = undefined; throw error; });
    const { app } = await application;
    request.url = apiPath(request.url ?? '/');
    await new Promise<void>((done) => {
      response.once('finish', done); response.once('close', done);
      app.server.emit('request', request, response);
    });
  } catch {
    // Configuration/database errors must not expose connection strings or keys.
    if (!response.headersSent) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'service_unavailable' }));
    }
  }
}
