import fs from 'fs';
import path from 'path';
import { Contract, JsonRpcProvider } from 'ethers';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';

/**
 * Suite 6 — the demo seed (claims C46–C49 in docs/TESTING.md). The seed is what the viva runs on, and before this
 * suite it was never executed by a test: that is how "no lab links", "not registered on the blockchain" and "every
 * date is today" all reached main.
 *
 * The seed only runs in development, and config/env.ts reads NODE_ENV once at import, so this file sets
 * NODE_ENV=development BEFORE its first import of anything from src/ — every import below is dynamic.
 *
 * Expected dates are written out here by hand (IST in the seed, UTC below), not read from the seed's own data.
 */

type Seed = typeof import('../../src/utils/seedDemoUsers');
type Models = {
  MedicalDocument: typeof import('../../src/models/MedicalDocument').MedicalDocument;
  LabLink: typeof import('../../src/models/LabLink').LabLink;
  AccessLog: typeof import('../../src/models/AccessLog').AccessLog;
  User: typeof import('../../src/models/User').User;
};

const EXPECTED_DOCUMENT_DATES: Record<string, string> = {
  'Cardiology Prescription - Hypertension Review': '2026-05-02T04:05:00.000Z',
  'Comprehensive Blood Test Report': '2026-05-07T02:45:00.000Z',
  'MRI Brain Scan - Follow-up Imaging': '2026-05-11T10:50:00.000Z',
  'Chest X-Ray Image - PA View': '2026-05-14T05:40:00.000Z',
  'Health Insurance Policy PDF': '2026-05-17T09:15:00.000Z',
  'Allergy Panel Report - Seasonal Rhinitis': '2026-05-18T06:50:00.000Z',
  'Vaccination Record - Adult Immunization': '2026-05-21T04:35:00.000Z',
  'Abdominal Ultrasound Summary': '2026-05-23T10:00:00.000Z',
  'Complete Blood Count (CBC)': '2026-05-24T03:30:00.000Z',
  'Lipid & Glucose Panel': '2026-05-25T04:45:00.000Z',
};

/** patient email -> the ACTIVE link to lab@jeevanlocker.dev the seed must create, requested then approved (UTC). */
const EXPECTED_LAB_LINKS: Record<string, { requestedAt: string; approvedAt: string }> = {
  'patient@jeevanlocker.dev': { requestedAt: '2026-05-20T04:35:00.000Z', approvedAt: '2026-05-20T14:12:00.000Z' },
  'patient2@jeevanlocker.dev': { requestedAt: '2026-05-21T05:50:00.000Z', approvedAt: '2026-05-22T03:25:00.000Z' },
};

let seed: Seed['seedDemoUsers'];
let models: Models;
let call: typeof import('../support/fixtures').call;
let adminToken: string;
const logs: string[] = [];
/** The first seed's on-chain summary line, kept so no test depends on which seed ran last. */
let firstRunSummary = '';

const runSeed = async () => {
  logs.length = 0;
  await seed();
};

const snapshot = async () => ({
  users: await models.User.countDocuments(),
  documents: (await models.MedicalDocument.find().sort({ title: 1 }).select('title blockchainTxHash').lean()).map((document) => `${document.title}=${document.blockchainTxHash ?? 'none'}`),
  links: await models.LabLink.countDocuments(),
  audits: await models.AccessLog.countDocuments(),
});

const integrityOfEveryDocument = async () => {
  const results: Record<string, string> = {};
  for (const document of await models.MedicalDocument.find().select('title')) {
    const response = await call('get', `/api/documents/${document._id.toString()}/integrity`, adminToken);
    results[document.title] = `${response.status}:${String(response.body.verified)}`;
  }
  return results;
};

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));

  seed = (await import('../../src/utils/seedDemoUsers')).seedDemoUsers;
  models = {
    MedicalDocument: (await import('../../src/models/MedicalDocument')).MedicalDocument,
    LabLink: (await import('../../src/models/LabLink')).LabLink,
    AccessLog: (await import('../../src/models/AccessLog')).AccessLog,
    User: (await import('../../src/models/User')).User,
  };
  call = (await import('../support/fixtures')).call;
  const { generateAuthToken } = await import('../../src/utils/auth.util');

  await runSeed();
  firstRunSummary = logs.find((line) => line.includes('Demo documents on-chain')) ?? '';
  adminToken = generateAuthToken((await models.User.findOne({ email: 'admin@jeevanlocker.dev' }))!);
}, 180_000);

describe('C46 every seeded document is encrypted, registered on-chain, and verifies', () => {
  it('ten documents, each a JLE1 file on disk, registered with its plaintext hash, and /integrity verified', async () => {
    const documents = await models.MedicalDocument.find();
    expect(documents.map((document) => document.title).sort()).toEqual(Object.keys(EXPECTED_DOCUMENT_DATES).sort());

    const { rpcUrl, documentRegistryAddress } = inject('chain');
    const provider = new JsonRpcProvider(rpcUrl);
    const registry = new Contract(documentRegistryAddress, ['function getDocumentHash(string documentId) view returns (bytes32)'], provider);
    const { UPLOAD_DIRECTORY } = await import('../../src/middleware/upload.middleware');

    try {
      for (const document of documents) {
        const label = document.title;
        expect(document.encryption, label).toBeDefined();
        expect(fs.readFileSync(path.join(UPLOAD_DIRECTORY, document.storedFileName)).subarray(0, 4).toString('latin1'), label).toBe('JLE1');
        expect(document.blockchainDocumentId, label).toBe(document._id.toString());
        expect(document.blockchainTxHash, label).toMatch(/^0x[0-9a-f]{64}$/);
        expect(await registry.getDocumentHash(document._id.toString()), label).toBe(`0x${document.documentHash}`);
      }
    } finally {
      provider.destroy();
    }

    const plaintextLeft = fs.readdirSync(UPLOAD_DIRECTORY).filter((name) => !name.endsWith('.enc'));
    expect(plaintextLeft).toEqual([]);

    expect(new Set(Object.values(await integrityOfEveryDocument()))).toEqual(new Set(['200:true']));
    expect(firstRunSummary).toContain('10 registered now');
  });
});

describe('C47 the demo lab is authorised by every patient it issued a report to', () => {
  it('one ACTIVE link per patient with a lab report, approved before the report, with its audit history', async () => {
    const lab = (await models.User.findOne({ email: 'lab@jeevanlocker.dev' }))!;
    const reports = await models.MedicalDocument.find({ uploadedByLab: lab._id }).populate<{ uploadedBy: { email: string } }>('uploadedBy', 'email');
    expect(reports.map((report) => report.uploadedBy.email).sort()).toEqual(Object.keys(EXPECTED_LAB_LINKS).sort());

    for (const report of reports) {
      const patient = (await models.User.findOne({ email: report.uploadedBy.email }))!;
      const links = await models.LabLink.find({ labId: lab._id, patientId: patient._id });
      expect(links, patient.email).toHaveLength(1);

      const [link] = links;
      const expected = EXPECTED_LAB_LINKS[patient.email];
      expect({ status: link.status, requestedAt: link.requestedAt.toISOString(), approvedAt: link.approvedAt?.toISOString() }, patient.email).toEqual({ status: 'ACTIVE', ...expected });
      expect(link.approvedAt!.getTime(), `${patient.email}: approved before the report`).toBeLessThan(report.createdAt.getTime());
      expect(link.approvedAt!.getTime()).toBeLessThan(report.reportDate!.getTime());

      for (const [action, actor] of [['LAB_LINK_REQUESTED', lab._id], ['LAB_LINKED', patient._id]] as const) {
        const rows = await models.AccessLog.find({ action, 'metadata.labLinkId': link._id.toString() });
        expect(rows, `${patient.email} ${action}`).toHaveLength(1);
        expect(rows[0].userId.toString()).toBe(actor.toString());
      }
    }
  });
});

describe('C48 seeded records carry their seeded dates', () => {
  it('every document has its seeded createdAt, not the time the seed ran', async () => {
    const actual = Object.fromEntries((await models.MedicalDocument.find().select('title createdAt')).map((document) => [document.title, document.createdAt.toISOString()]));
    expect(actual).toEqual(EXPECTED_DOCUMENT_DATES);
  });
});

describe('C49 re-seeding is idempotent, including against a chain that already holds the registrations', () => {
  it('a second seed writes nothing new and sends no transaction', async () => {
    const before = await snapshot();
    await runSeed();

    expect(await snapshot()).toEqual(before);
    expect(logs.find((line) => line.includes('Demo documents on-chain'))).toContain('10 already registered');
  });

  it('rows that lost their chain fields (chain kept) are refilled with the ORIGINAL transactions, not re-sent', async () => {
    const before = await snapshot();
    await models.MedicalDocument.updateMany({}, { $unset: { blockchainDocumentId: 1, blockchainTxHash: 1, blockchainRegisteredAt: 1 } });
    await runSeed();

    expect(await snapshot()).toEqual(before);
    expect(new Set(Object.values(await integrityOfEveryDocument()))).toEqual(new Set(['200:true']));
  });

  it('a fresh database against the same chain (the dev restart) registers new ids with no conflict', async () => {
    await models.MedicalDocument.deleteMany({});
    await runSeed();

    expect(logs.find((line) => line.includes('Demo documents on-chain'))).toContain('10 registered now, 0 already registered, 0 conflicting');
    expect(new Set(Object.values(await integrityOfEveryDocument()))).toEqual(new Set(['200:true']));
    expect(await models.LabLink.countDocuments()).toBe(2);
  });

  it('dates survive a re-seed of existing rows', async () => {
    await runSeed();
    const actual = Object.fromEntries((await models.MedicalDocument.find().select('title createdAt')).map((document) => [document.title, document.createdAt.toISOString()]));
    expect(actual).toEqual(EXPECTED_DOCUMENT_DATES);
  });
});
