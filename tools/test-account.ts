// Account setup for isolated, in-memory tests and benchmarks only.
import type { buildApp } from '../apps/api/src/app.js';
export async function testAccountCookie(app: Awaited<ReturnType<typeof buildApp>>['app']) {
  const response = await app.inject({ method: 'POST', url: '/auth/signup', headers: { 'x-voiceai-auth': '1' },
    payload: { username: 'test_account', password: 'test-password-123' } });
  if (response.statusCode !== 201) throw new Error('test_account_setup_failed');
  return String(response.headers['set-cookie']).split(';')[0];
}
