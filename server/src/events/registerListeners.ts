import { registerNoopListener } from './listeners/noop.listener';
import { registerNotificationListener } from './listeners/notification.listener';

/**
 * Wires every app-event listener exactly once at boot (called from index.ts before app.listen).
 * Add new listeners here; nothing else needs to know they exist.
 */
export const registerAppEventListeners = (): void => {
  registerNoopListener();
  registerNotificationListener();
};
