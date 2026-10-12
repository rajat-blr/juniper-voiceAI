import type { BookingApi } from './recovery';

/** Bounded requests without automatic write retries. Recovery owns operation IDs. */
export function createBookingApi(getToken: () => string, expired: () => void,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}): BookingApi {
  const send = options.fetch ?? fetch;
  return async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
    const token = getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let response: Response;
    let result: unknown;
    try {
      response = await send(`/api${path}`, {
        method, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      result = await response.json();
    } catch {
      // A timeout can hide a successful write. Leave persisted confirmation intact.
      throw new Error('connection_failed');
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const status = (result as { status?: unknown } | null)?.status;
      const reason = typeof status === 'string' && /^[a-z_]{1,64}$/.test(status) ? status : 'api_error';
      // An old request must not expire a freshly created session.
      if (reason === 'session_expired' && token === getToken()) expired();
      throw new Error(reason);
    }
    return result as T;
  };
}
