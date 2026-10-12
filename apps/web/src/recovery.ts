import type { Session } from '../../api/src/booking';

export type BookingApi = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

export async function recoverSession(api: BookingApi): Promise<{ session: Session; recovered: boolean; issue?: string }> {
  let session = await api<Session>('/session');
  const state = session.state;
  if (!state.confirmed || !state.pendingOperationId) return { session, recovered: false };
  try {
    await api(`/operations/${encodeURIComponent(state.pendingOperationId)}`);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'not_found') throw error;
    // Confirmation and this ID were persisted before sending the original write.
    // Retry that exact operation; never infer confirmation from an offered slot.
    if (!state.selectedSlot || !state.intent) throw new Error('confirmation_incomplete');
    try {
      await api(state.intent === 'reschedule'
        ? `/bookings/${encodeURIComponent(state.reference!)}/reschedule` : '/bookings', {
        operationId: state.pendingOperationId, slot: state.selectedSlot, confirmed: true,
        ...(state.intent === 'book' ? { serviceId: state.serviceId, visitorName: state.visitorName } : {}),
      });
    } catch (failure) {
      if (!(failure instanceof Error) || !['slot_unavailable', 'invalid_time'].includes(failure.message)) throw failure;
      session = await api<Session>('/session');
      if (session.state.confirmed && session.state.pendingOperationId === state.pendingOperationId) {
        const { selectedSlot: _slot, pendingOperationId: _operation, ...remaining } = session.state;
        // A definitive conflict leaves the old appointment intact and requires
        // a new selection and confirmation. Unknown network outcomes stay pending.
        try {
          session = await api<Session>('/session', { version: session.version, state: { ...remaining, confirmed: false } }, 'PATCH');
        } catch (conflict) {
          if (!(conflict instanceof Error) || conflict.message !== 'version_conflict') throw conflict;
          session = await api<Session>('/session');
        }
      }
      return { session, recovered: false, issue: failure.message };
    }
  }
  return { session: await api<Session>('/session'), recovered: true };
}
