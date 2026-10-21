import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerNotificationListener } from '../../src/events/listeners/notification.listener';
import { Notification } from '../../src/models/Notification';
import type { IUser } from '../../src/models/User';
import { call, createUser, requestConsent, requestLabLink, tokenFor, uploadDocument } from '../support/fixtures';
import { waitFor } from '../support/waitFor';

/**
 * Suite 1e — notifications belong to their recipient, object by object (claim C56 in docs/TESTING.md).
 *
 * The route inventory (C3) only proves every role may call these routes. This file proves what each caller reaches:
 * their own rows and nothing else. Another user's notification id must look exactly like an id that does not exist —
 * 404, not 403 — so an id can never be confirmed. Notifications are produced the real way: the listener the server
 * registers at boot is registered here, and real requests emit the events it persists.
 */

interface NotificationJson {
  id: string;
  read: boolean;
}

const list = async (user: IUser) => {
  const response = await call('get', '/api/notifications', tokenFor(user));
  expect(response.status).toBe(200);
  return response.body as { notifications: NotificationJson[]; unreadCount: number };
};

const unreadOf = (user: IUser) => Notification.countDocuments({ recipientUserId: user._id, read: false });

/** Two notifications for `patient`: a consent request and a lab-link request, both through the real handlers. */
const notify = async (patient: IUser) => {
  const doctor = await createUser('doctor');
  const lab = await createUser('lab');
  await requestConsent(doctor, patient, (await uploadDocument(patient)).id);
  await requestLabLink(lab, patient);
  await waitFor(async () => (await unreadOf(patient)) === 2, { description: `two notifications for ${patient.email}` });
};

let alice: IUser;
let bob: IUser;

beforeAll(async () => {
  registerNotificationListener();
  alice = await createUser('patient');
  bob = await createUser('patient');
  await notify(alice);
  await notify(bob);
});

describe('C56 a notification is reachable only by its recipient', () => {
  it('the list is strictly the caller’s own, and unreadCount counts only the caller’s rows', async () => {
    for (const user of [alice, bob]) {
      const own = (await Notification.find({ recipientUserId: user._id }).lean()).map((row) => row._id.toString()).sort();
      const body = await list(user);
      expect(body.notifications.map((notification) => notification.id).sort()).toEqual(own);
      expect(body.unreadCount).toBe(own.length);
    }

    // An admin is not special here: notifications are personal, not an audit feed.
    for (const outsider of [await createUser('admin'), await createUser('doctor'), await createUser('lab')]) {
      expect(await list(outsider), outsider.role).toEqual({ notifications: [], unreadCount: 0 });
    }
  });

  it('every serialized notification carries exactly the documented fields — no recipient, actor id or dedupe key', async () => {
    const [notification] = (await list(alice)).notifications;
    expect(Object.keys(notification).sort()).toEqual(['actorName', 'createdAt', 'documentId', 'eventName', 'id', 'message', 'read']);
  });

  it('another user marking my notification read gets the same 404 as an id that does not exist, and my row stays unread', async () => {
    const [target] = (await list(alice)).notifications;
    const unknownId = new Types.ObjectId().toString();

    const unknown = await call('patch', `/api/notifications/${unknownId}/read`, tokenFor(bob));
    expect(unknown.status).toBe(404);

    for (const intruder of [bob, await createUser('admin'), await createUser('doctor'), await createUser('lab')]) {
      const response = await call('patch', `/api/notifications/${target.id}/read`, tokenFor(intruder));
      expect(response.status, intruder.role).toBe(404);
      expect(response.body, intruder.role).toEqual(unknown.body);
      expect(response.headers['content-length'], intruder.role).toBe(unknown.headers['content-length']);
    }

    expect((await Notification.findById(target.id).lean())!.read).toBe(false);
    expect(await unreadOf(alice)).toBe(2);
  });

  it('a malformed id is the same 400 for everyone', async () => {
    const own = await call('patch', '/api/notifications/not-an-id/read', tokenFor(alice));
    const other = await call('patch', '/api/notifications/not-an-id/read', tokenFor(bob));
    expect(own.status).toBe(400);
    expect(other.body).toEqual(own.body);
  });

  it('mark-all-read touches only the caller’s rows', async () => {
    const before = await unreadOf(alice);
    expect(before).toBeGreaterThan(0);

    const response = await call('patch', '/api/notifications/read-all', tokenFor(bob));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ modifiedCount: 2 });

    expect(await unreadOf(bob)).toBe(0);
    expect(await unreadOf(alice)).toBe(before);
    expect((await list(alice)).unreadCount).toBe(before);
  });

  it('the recipient marks one read: 200 with the updated notification, and no deprecated-option warning', async () => {
    const warnings: Error[] = [];
    const collect = (warning: Error) => warnings.push(warning);
    process.on('warning', collect);

    try {
      const [target] = (await list(alice)).notifications.filter((notification) => !notification.read);
      const response = await call('patch', `/api/notifications/${target.id}/read`, tokenFor(alice));
      expect(response.status).toBe(200);
      expect(response.body.notification).toMatchObject({ id: target.id, read: true });
      expect((await Notification.findById(target.id).lean())!.read).toBe(true);
      // Warnings are emitted asynchronously (process.nextTick).
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', collect);
    }

    expect(warnings.map((warning) => warning.message).filter((message) => /new.*option|returnDocument/i.test(message))).toEqual([]);
  });
});
