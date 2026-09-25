import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { app } from '../../src/app';
import { User, type IUser } from '../../src/models/User';
import type { UserRole } from '../../src/types/user.types';
import { generateAuthToken } from '../../src/utils/auth.util';

/**
 * Test data built through the real code paths. Users are the one shortcut: they are inserted directly with a
 * cost-4 bcrypt hash (the User pre-save hook uses cost 12, ~300 ms per user, which would dominate the suite).
 * insertMany skips save middleware but still runs schema validation and defaults. Everything else — uploads,
 * shares, consents, grants, lab links, lab reports — goes over HTTP, so a fixture is also a happy-path check.
 */

export const TEST_PASSWORD = 'Correct-Horse-Battery-9';

let testPasswordHash: string | undefined;
const hashedTestPassword = () => (testPasswordHash ??= bcrypt.hashSync(TEST_PASSWORD, 4));

export const uniqueSuffix = () => randomBytes(5).toString('hex');

export interface CreateUserOptions {
  name?: string;
  email?: string;
  /** Doctors default to verified (most tests want a working doctor); pass false for the gate tests. */
  verified?: boolean;
  organisation?: string;
}

/** Verified by construction for admins and labs; doctors verified unless asked otherwise; patients carry the default. */
const defaultVerified = (role: UserRole) => role !== 'patient';

export const createUser = async (role: UserRole, options: CreateUserOptions = {}): Promise<IUser> => {
  const suffix = uniqueSuffix();
  const organisation = options.organisation ?? (role === 'lab' ? `Test Diagnostics ${suffix}` : undefined);
  const [user] = await User.insertMany([
    {
      name: options.name ?? `Test ${role} ${suffix}`,
      email: options.email ?? `${role}-${suffix}@test.jeevanlocker.dev`,
      password: hashedTestPassword(),
      role,
      verified: options.verified ?? defaultVerified(role),
      ...(organisation ? { organisation } : {}),
    },
  ]);
  return user;
};

export const tokenFor = (user: IUser) => generateAuthToken(user);

export const idOf = (user: IUser) => user._id.toString();

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** One request against the in-process app. supertest binds it to an ephemeral port for the call. */
export const call = (method: HttpMethod, url: string, token?: string): Test => {
  const pending = request(app)[method](url);
  return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
};

/** Fails with the response body in the message, so a broken fixture says why instead of "expected 201". */
export const expectStatus = (response: Response, status: number, context: string): Response => {
  if (response.status !== status) {
    throw new Error(`${context}: expected ${status}, got ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response;
};

/** A minimal file that passes the PDF magic-byte check. Random content, so every upload has a distinct hash. */
export const samplePdf = () => Buffer.from(`%PDF-1.4\n% jeevanlocker test ${uniqueSuffix()}\n1 0 obj << >> endobj\n%%EOF\n`, 'latin1');

export interface DocumentJson {
  id: string;
  title: string;
}

export const uploadDocument = async (patient: IUser, title = `Record ${uniqueSuffix()}`): Promise<DocumentJson> => {
  const response = await call('post', '/api/documents/upload', tokenFor(patient))
    .field('title', title)
    .attach('file', samplePdf(), { filename: 'record.pdf', contentType: 'application/pdf' });
  return (expectStatus(response, 201, 'upload document').body as { document: DocumentJson }).document;
};

export const shareDocument = async (patient: IUser, documentId: string, doctor: IUser) => {
  const response = await call('patch', `/api/documents/${documentId}/share`, tokenFor(patient)).send({ doctorId: idOf(doctor) });
  expectStatus(response, 200, 'share document');
};

export interface ConsentJson {
  id: string;
  status: string;
}

export const requestConsent = async (doctor: IUser, patient: IUser, documentId: string): Promise<ConsentJson> => {
  const response = await call('post', '/api/consents/request', tokenFor(doctor)).send({
    patientId: idOf(patient),
    documentId,
    purpose: 'Test consultation',
  });
  return (expectStatus(response, 201, 'request consent').body as { consent: ConsentJson }).consent;
};

export const decideConsent = async (patient: IUser, consentId: string, action: 'approve' | 'reject' | 'revoke'): Promise<ConsentJson> => {
  const response = await call('patch', `/api/consents/${consentId}/${action}`, tokenFor(patient));
  return (expectStatus(response, 200, `${action} consent`).body as { consent: ConsentJson }).consent;
};

export const approvedConsent = async (doctor: IUser, patient: IUser, documentId: string) =>
  decideConsent(patient, (await requestConsent(doctor, patient, documentId)).id, 'approve');

export interface EmergencyAccessJson {
  id: string;
  status: string;
  afterRevocation?: boolean;
}

export const breakGlass = async (doctor: IUser, patient: IUser, documentId: string): Promise<EmergencyAccessJson> => {
  const response = await call('post', '/api/emergency-access', tokenFor(doctor)).send({
    patientId: idOf(patient),
    documentId,
    reason: 'Test emergency: patient unresponsive',
  });
  return (expectStatus(response, 201, 'break glass').body as { emergencyAccess: EmergencyAccessJson }).emergencyAccess;
};

export const revokeGrant = async (patient: IUser, grantId: string) => {
  expectStatus(await call('delete', `/api/emergency-access/${grantId}`, tokenFor(patient)), 200, 'revoke emergency access');
};

export interface LabLinkJson {
  id: string;
  status: string;
}

export const requestLabLink = async (lab: IUser, patient: IUser): Promise<LabLinkJson> => {
  const response = await call('post', '/api/lab-links', tokenFor(lab)).send({ query: patient.email });
  return (expectStatus(response, 201, 'request lab link').body as { link: LabLinkJson }).link;
};

export const decideLabLink = async (patient: IUser, linkId: string, action: 'approve' | 'reject' | 'revoke'): Promise<LabLinkJson> => {
  const response =
    action === 'revoke'
      ? await call('delete', `/api/lab-links/${linkId}`, tokenFor(patient))
      : await call('patch', `/api/lab-links/${linkId}/${action}`, tokenFor(patient));
  return (expectStatus(response, 200, `${action} lab link`).body as { link: LabLinkJson }).link;
};

export const activeLabLink = async (lab: IUser, patient: IUser) => decideLabLink(patient, (await requestLabLink(lab, patient)).id, 'approve');

/** Needs an ACTIVE link between the two. */
export const issueLabReport = async (lab: IUser, patient: IUser, title = `Lab report ${uniqueSuffix()}`): Promise<DocumentJson> => {
  const response = await call('post', '/api/lab/reports', tokenFor(lab))
    .field('patientId', idOf(patient))
    .field('title', title)
    .attach('file', samplePdf(), { filename: 'report.pdf', contentType: 'application/pdf' });
  return (expectStatus(response, 201, 'issue lab report').body as { document: DocumentJson }).document;
};
