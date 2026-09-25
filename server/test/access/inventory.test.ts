import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { UNVERIFIED_DOCTOR_MESSAGE } from '../../src/middleware/auth.middleware';
import { User, type IUser } from '../../src/models/User';
import { call, createUser, tokenFor, type HttpMethod } from '../support/fixtures';
import { SERVER_ROOT } from '../support/hardhat';

/**
 * Suite 1a — every route against every role (claims C1–C4 in docs/TESTING.md).
 *
 * ROUTES below is the access specification, written by hand from docs/API_LAB.md, docs/API_ADMIN.md and the
 * documented intent of each route. It is NOT derived from the route files: if a route's roles change, this
 * table must be changed consciously in the same review.
 *
 * The inventory guard makes the table exhaustive. It reads every router actually mounted on the app and fails
 * if any route exists without a row here — so an endpoint cannot ship without an access decision on record.
 */

const ROLE_FORBIDDEN_MESSAGE = 'You do not have permission to access this resource';

type Role = 'patient' | 'doctor' | 'unverifiedDoctor' | 'admin' | 'lab';
type Actor = Role | 'anonymous';

interface RouteSpec {
  method: HttpMethod;
  /** Full path as mounted, with Express params, e.g. /api/documents/:id/share */
  path: string;
  /** Roles that get past the role / verification gates. 'public' = no token required. */
  access: 'public' | readonly Role[];
}

const ALL: readonly Role[] = ['patient', 'doctor', 'unverifiedDoctor', 'admin', 'lab'];
const DOCTOR_ANY_VERIFICATION: readonly Role[] = ['doctor', 'unverifiedDoctor'];

/**
 * Verification gates initiating new access (lookup, consent request, break-glass), not access the patient already
 * gave (API_ADMIN.md §3): an unverified doctor passes every other doctor route.
 */
const ROUTES: readonly RouteSpec[] = [
  { method: 'get', path: '/api/health', access: 'public' },

  { method: 'post', path: '/api/auth/register', access: 'public' },
  { method: 'post', path: '/api/auth/login', access: 'public' },
  { method: 'get', path: '/api/auth/me', access: ALL },

  { method: 'get', path: '/api/documents/doctors', access: ['patient', 'admin'] },
  { method: 'post', path: '/api/documents/upload', access: ['patient'] },
  { method: 'get', path: '/api/documents/my-documents', access: ALL },
  { method: 'get', path: '/api/documents/:id/view', access: ALL },
  { method: 'get', path: '/api/documents/:id/download', access: ALL },
  { method: 'get', path: '/api/documents/:id/integrity', access: ALL },
  { method: 'get', path: '/api/documents/:id', access: ALL },
  { method: 'patch', path: '/api/documents/:id/share', access: ['patient'] },

  { method: 'post', path: '/api/emergency-access', access: ['doctor'] },
  { method: 'get', path: '/api/emergency-access', access: ['patient', ...DOCTOR_ANY_VERIFICATION] },
  { method: 'delete', path: '/api/emergency-access/:id', access: ['patient'] },

  { method: 'post', path: '/api/consents/request', access: ['doctor'] },
  { method: 'get', path: '/api/consents/my', access: DOCTOR_ANY_VERIFICATION },
  { method: 'get', path: '/api/consents/pending', access: ['patient'] },
  { method: 'get', path: '/api/consents/received', access: ['patient'] },
  { method: 'patch', path: '/api/consents/:id/approve', access: ['patient'] },
  { method: 'patch', path: '/api/consents/:id/reject', access: ['patient'] },
  { method: 'patch', path: '/api/consents/:id/revoke', access: ['patient'] },

  { method: 'get', path: '/api/patients/lookup', access: ['doctor'] },

  { method: 'get', path: '/api/audit/summary', access: ['admin'] },

  { method: 'get', path: '/api/admin/anchors', access: ['admin'] },
  { method: 'get', path: '/api/admin/anchors/:id/verify', access: ['admin'] },
  { method: 'post', path: '/api/admin/anchors/:id/retry', access: ['admin'] },
  { method: 'get', path: '/api/admin/users', access: ['admin'] },
  { method: 'post', path: '/api/admin/users', access: ['admin'] },
  { method: 'patch', path: '/api/admin/users/:id/verify', access: ['admin'] },

  { method: 'post', path: '/api/lab-links', access: ['lab'] },
  { method: 'get', path: '/api/lab-links', access: ['patient', 'lab'] },
  { method: 'patch', path: '/api/lab-links/:id/approve', access: ['patient'] },
  { method: 'patch', path: '/api/lab-links/:id/reject', access: ['patient'] },
  { method: 'delete', path: '/api/lab-links/:id', access: ['patient'] },

  { method: 'post', path: '/api/lab/reports', access: ['lab'] },

  { method: 'get', path: '/api/notifications', access: ALL },
  { method: 'patch', path: '/api/notifications/read-all', access: ALL },
  { method: 'patch', path: '/api/notifications/:id/read', access: ALL },
];

/** Where each routes file is mounted (mirrors app.ts). A new routes file needs an entry here AND access rows above. */
const ROUTER_PREFIX: Record<string, string> = {
  'admin.routes.ts': '/api/admin',
  'audit.routes.ts': '/api/audit',
  'auth.routes.ts': '/api/auth',
  'consent.routes.ts': '/api/consents',
  'document.routes.ts': '/api/documents',
  'emergencyAccess.routes.ts': '/api/emergency-access',
  'labLink.routes.ts': '/api/lab-links',
  'labReport.routes.ts': '/api/lab/reports',
  'notification.routes.ts': '/api/notifications',
  'patients.routes.ts': '/api/patients',
};

const routeKey = (method: string, routePath: string) => `${method.toUpperCase()} ${routePath}`;

// ---------- reading the real router stacks (Express 5 keeps route paths and methods on each route) ----------

interface RouteLike {
  path: string;
  methods: Record<string, boolean>;
}
interface LayerLike {
  route?: RouteLike;
  handle: unknown;
}

const stackOf = (value: unknown): LayerLike[] | null => {
  if ((typeof value === 'function' || typeof value === 'object') && value !== null) {
    const stack: unknown = Reflect.get(value, 'stack');
    return Array.isArray(stack) ? (stack as LayerLike[]) : null;
  }
  return null;
};

const routesOf = (stack: LayerLike[], prefix: string) =>
  stack.flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((method) => routeKey(method, `${prefix}${layer.route!.path === '/' ? '' : layer.route!.path}`)) : []
  );

describe('route inventory: every mounted route has an access row', () => {
  it('matches the access table exactly — no route without a row, no row without a route', async () => {
    const appStack = stackOf(Reflect.get(app, 'router'));
    if (!appStack) throw new Error('Could not read the Express app router stack');

    const routesDirectory = path.join(SERVER_ROOT, 'src', 'routes');
    const routeFiles = fs.readdirSync(routesDirectory).filter((file) => file.endsWith('.routes.ts')).sort();

    // Every routes file must declare its mount prefix, and no stale prefix may linger.
    expect(routeFiles.filter((file) => !(file in ROUTER_PREFIX)), 'routes files with no prefix entry').toEqual([]);
    expect(Object.keys(ROUTER_PREFIX).filter((file) => !routeFiles.includes(file)), 'prefix entries with no file').toEqual([]);

    const mountedRouters = appStack.map((layer) => layer.handle).filter((handle) => stackOf(handle) !== null);
    const discovered: string[] = [...routesOf(appStack, '')];

    for (const file of routeFiles) {
      const router: unknown = ((await import(path.join(routesDirectory, file))) as { default: unknown }).default;
      const stack = stackOf(router);
      if (!stack) throw new Error(`${file} does not export an Express router`);

      // Mounted exactly once, and no nested routers the inventory would not see into.
      expect(mountedRouters.filter((handle) => handle === router), `${file} mounted on the app`).toHaveLength(1);
      expect(stack.filter((layer) => !layer.route && stackOf(layer.handle) !== null), `nested routers in ${file}`).toEqual([]);

      discovered.push(...routesOf(stack, ROUTER_PREFIX[file]));
    }

    // Every router mounted on the app came from a routes file (a router defined inline would escape the table).
    expect(mountedRouters.length, 'routers mounted on the app').toBe(routeFiles.length);

    const specified = ROUTES.map((route) => routeKey(route.method, route.path));
    expect(new Set(specified).size, 'duplicate rows in ROUTES').toBe(specified.length);
    expect(discovered.filter((key) => !specified.includes(key)), 'routes with NO access row — add them to ROUTES').toEqual([]);
    expect(specified.filter((key) => !discovered.includes(key)), 'rows for routes that no longer exist').toEqual([]);
  });
});

// ---------- the gate grid: 6 actors x every route ----------

const actors: Record<Role, IUser | null> = { patient: null, doctor: null, unverifiedDoctor: null, admin: null, lab: null };
const tokenOf = (actor: Actor) => {
  if (actor === 'anonymous') return undefined;
  const user = actors[actor];
  if (!user) throw new Error(`fixture ${actor} missing`);
  return tokenFor(user);
};

beforeAll(async () => {
  actors.patient = await createUser('patient');
  actors.doctor = await createUser('doctor');
  actors.unverifiedDoctor = await createUser('doctor', { verified: false });
  actors.admin = await createUser('admin');
  actors.lab = await createUser('lab');
});

/** Path params become a random, well-formed ObjectId: an allowed role then gets a 404/400, never an object-level 403. */
const concreteUrl = (routePath: string) => routePath.replace(/:[A-Za-z]+/g, () => new Types.ObjectId().toString());

type Expected = { kind: 'unauthenticated' } | { kind: 'forbidden'; message: string } | { kind: 'passes' };

const expectedFor = (route: RouteSpec, actor: Actor): Expected => {
  if (route.access === 'public') return { kind: 'passes' };
  if (actor === 'anonymous') return { kind: 'unauthenticated' };
  if (route.access.includes(actor)) return { kind: 'passes' };
  if (actor === 'unverifiedDoctor' && route.access.includes('doctor')) return { kind: 'forbidden', message: UNVERIFIED_DOCTOR_MESSAGE };
  return { kind: 'forbidden', message: ROLE_FORBIDDEN_MESSAGE };
};

/**
 * Public routes are probed as anonymous and as one authenticated user only: register and login sit behind
 * per-IP limiters (5/hour, 10/15 min), and every request here comes from 127.0.0.1.
 */
const actorsFor = (route: RouteSpec): Actor[] =>
  route.access === 'public' ? ['anonymous', 'patient'] : ['anonymous', 'patient', 'doctor', 'unverifiedDoctor', 'admin', 'lab'];

const cells = ROUTES.flatMap((route) => actorsFor(route).map((actor) => ({ route, actor })));

describe('gate grid: each role is let through or turned away exactly as specified', () => {
  it.each(cells)('$route.method $route.path as $actor', async ({ route, actor }) => {
    const url = concreteUrl(route.path);
    const pending = call(route.method, url, tokenOf(actor));
    const response = route.method === 'get' || route.method === 'delete' ? await pending : await pending.send({});
    const expected = expectedFor(route, actor);
    const context = `${route.method.toUpperCase()} ${url} as ${actor} -> ${response.status} ${JSON.stringify(response.body)}`;

    // A route-level 404 means the table's path is wrong, and the cell would prove nothing.
    expect(String(response.body?.message ?? ''), context).not.toMatch(/^Route not found/);

    if (expected.kind === 'unauthenticated') {
      expect(response.status, context).toBe(401);
      expect(response.body.message, context).toBe('Authentication token is required');
    } else if (expected.kind === 'forbidden') {
      expect(response.status, context).toBe(403);
      expect(response.body.message, context).toBe(expected.message);
    } else {
      expect([401, 403], context).not.toContain(response.status);
      expect(response.status, context).toBeLessThan(500);
    }
  });
});

// ---------- tokens: identity and role come from the database, never from the token's claims ----------

describe('tokens: the role in a JWT is not trusted', () => {
  const sign = (payload: object, options: jwt.SignOptions = {}, secret = process.env.JWT_SECRET ?? '') =>
    jwt.sign(payload, secret, { expiresIn: '1h', ...options });

  it('a patient token that claims role admin is still a patient', async () => {
    const forged = sign({ userId: actors.patient!._id.toString(), role: 'admin' });

    for (const url of ['/api/admin/users', '/api/audit/summary', '/api/admin/anchors']) {
      const response = await call('get', url, forged);
      expect(response.status, url).toBe(403);
      expect(response.body.message).toBe(ROLE_FORBIDDEN_MESSAGE);
    }
    expect((await call('get', '/api/auth/me', forged)).body.user.role).toBe('patient');
  });

  it('an admin token that claims role patient is still an admin', async () => {
    const understated = sign({ userId: actors.admin!._id.toString(), role: 'patient' });
    expect((await call('get', '/api/admin/users', understated)).status).toBe(200);
  });

  it('a lab token that claims role doctor cannot look up patients or break glass', async () => {
    const forged = sign({ userId: actors.lab!._id.toString(), role: 'doctor' });
    expect((await call('get', '/api/patients/lookup?query=x@example.com', forged)).status).toBe(403);
    expect((await call('post', '/api/emergency-access', forged).send({})).status).toBe(403);
  });

  it.each([
    ['signed with another secret', () => sign({ userId: actors.patient!._id.toString(), role: 'patient' }, {}, 'not-the-server-secret-'.repeat(3)), 'Invalid authentication token'],
    ['expired', () => sign({ userId: actors.patient!._id.toString(), role: 'patient' }, { expiresIn: -10 }), 'Authentication token has expired'],
    ['for a user that no longer exists', () => sign({ userId: new Types.ObjectId().toString(), role: 'admin' }), 'Authenticated user no longer exists'],
    ['with no userId claim', () => sign({ role: 'admin' }), 'Invalid authentication token'],
    ['that is not a JWT at all', () => 'not.a.jwt', 'Invalid authentication token'],
  ])('rejects a token %s with 401', async (_label, makeToken, message) => {
    const response = await call('get', '/api/auth/me', makeToken());
    expect(response.status).toBe(401);
    expect(response.body.message).toBe(message);
  });

  it('rejects a non-Bearer authorization header as missing', async () => {
    const response = await call('get', '/api/auth/me').set('Authorization', `Basic ${tokenFor(actors.admin!)}`);
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Authentication token is required');
  });

  it('a deleted user’s still-valid token stops working immediately', async () => {
    const doomed = await createUser('admin');
    const token = tokenFor(doomed);
    expect((await call('get', '/api/admin/users', token)).status).toBe(200);

    await User.deleteOne({ _id: doomed._id });
    const response = await call('get', '/api/admin/users', token);
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Authenticated user no longer exists');
  });
});
