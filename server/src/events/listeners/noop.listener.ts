import { env } from '../../config/env';
import { onAnyAppEvent } from '../appEvents';

/**
 * Placeholder listener so the emitter has a subscriber from day one. In development it echoes each
 * event to the console; elsewhere it does nothing. The Notification listener (model + NOTIFICATION_SENT
 * audit + bell) replaces or joins it in registerListeners.ts.
 */
export const registerNoopListener = (): (() => void) =>
  onAnyAppEvent((name, payload) => {
    if (env.nodeEnv === 'development') {
      console.debug(`[event] ${name} -> ${payload.recipientUserId}: ${payload.message}`);
    }
  });
