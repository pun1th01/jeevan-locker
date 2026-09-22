import { Types } from 'mongoose';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  buildConsentPreimage,
  buildEmergencyGrantedPreimage,
  buildEmergencyRevokedPreimage,
  consentRecordKey,
  emergencyRecordKey,
  sha256Hex,
} from '../services/anchorPreimage.service';

/**
 * Asserts that the worked example in docs/ANCHORING.md still matches what the code produces.
 *
 * The preimage bytes are a published verification format: anyone holding a database row must be able to
 * recompute the on-chain digest years later. Reordering a key, renaming one, or adding a field would
 * silently invalidate every anchor already written. This script is the guard — it touches no database and
 * no chain, so it can run anywhere in under a second.
 *
 *   npm run verify:anchors        (from server/)
 *
 * If it fails, either the change to anchorPreimage.service.ts is wrong, or it is a deliberate new preimage
 * VERSION and docs/ANCHORING.md plus these fixtures must be updated together.
 */

const id = (hex: string) => new Types.ObjectId(hex);

const PATIENT = id('66f2a1b3c4d5e6f708192a01');
const DOCTOR = id('66f2a1b3c4d5e6f708192a02');
const DOCUMENT = id('66f2a1b3c4d5e6f708192a10');
const DOCUMENT_HASH = '4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e';

const CONSENT_ID = id('66f2a1b3c4d5e6f708192a3b');
const EMERGENCY_ID = id('66f2a1b3c4d5e6f708192b77');

interface Expectation {
  label: string;
  preimage: string | null;
  expectedPreimage: string;
  expectedDigest: string;
  recordKey: string;
  expectedChainKey: string;
}

const consent = {
  _id: CONSENT_ID,
  patientId: PATIENT,
  doctorId: DOCTOR,
  documentId: DOCUMENT,
  purpose: 'Pre-operative cardiology review',
  requestedAt: new Date('2026-09-21T09:15:00.000Z'),
  approvedAt: new Date('2026-09-21T09:42:17.512Z'),
  rejectedAt: undefined,
  revokedAt: undefined,
};

const grant = {
  _id: EMERGENCY_ID,
  doctorId: DOCTOR,
  patientId: PATIENT,
  documentId: DOCUMENT,
  reason: 'Patient unconscious in ED',
  createdAt: new Date('2026-09-21T22:03:41.000Z'),
  expiresAt: new Date('2026-09-21T22:18:41.000Z'),
  revokedAt: new Date('2026-09-21T22:07:05.220Z'),
  revokedBy: PATIENT,
};

const expectations: Expectation[] = [
  {
    label: 'consent APPROVED',
    preimage: buildConsentPreimage(consent, 'APPROVED', DOCUMENT_HASH),
    expectedPreimage:
      '{"v":1,"type":"consent","event":"APPROVED","consentId":"66f2a1b3c4d5e6f708192a3b","patientId":"66f2a1b3c4d5e6f708192a01","doctorId":"66f2a1b3c4d5e6f708192a02","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","purpose":"Pre-operative cardiology review","occurredAt":"2026-09-21T09:42:17.512Z"}',
    expectedDigest: '17cec17ef072de9a90c4924e8055fe08bf918d525fbb6e39bea09e21b2971d42',
    recordKey: consentRecordKey(CONSENT_ID.toString(), 'APPROVED'),
    expectedChainKey: '0x00370c5ff059a06d708263b9784bb72129018aa895bb62a2805e2420ac1ff871',
  },
  {
    label: 'emergency GRANTED',
    preimage: buildEmergencyGrantedPreimage(grant, DOCUMENT_HASH),
    expectedPreimage:
      '{"v":1,"type":"emergency","event":"GRANTED","emergencyAccessId":"66f2a1b3c4d5e6f708192b77","doctorId":"66f2a1b3c4d5e6f708192a02","patientId":"66f2a1b3c4d5e6f708192a01","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","reason":"Patient unconscious in ED","createdAt":"2026-09-21T22:03:41.000Z","expiresAt":"2026-09-21T22:18:41.000Z"}',
    expectedDigest: '93e8f759f1577b8f403e25d84dcb7b7b6fa5efe6fed2498362b40ecfbaa9e01f',
    recordKey: emergencyRecordKey(EMERGENCY_ID.toString(), 'GRANTED'),
    expectedChainKey: '0x3bb0c68d2a59886fb82f5c31bbac64b197da87f21fb1bae028524df10333f6f0',
  },
  {
    label: 'emergency REVOKED',
    preimage: buildEmergencyRevokedPreimage(grant, DOCUMENT_HASH),
    expectedPreimage:
      '{"v":1,"type":"emergency","event":"REVOKED","emergencyAccessId":"66f2a1b3c4d5e6f708192b77","doctorId":"66f2a1b3c4d5e6f708192a02","patientId":"66f2a1b3c4d5e6f708192a01","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","grantedAt":"2026-09-21T22:03:41.000Z","revokedBy":"66f2a1b3c4d5e6f708192a01","revokedAt":"2026-09-21T22:07:05.220Z"}',
    expectedDigest: 'a667a8b1f962a04b0c6ce1ccada4d8262bee7f55b963cd6b3f1df4cdf7b9eec8',
    recordKey: emergencyRecordKey(EMERGENCY_ID.toString(), 'REVOKED'),
    expectedChainKey: '0x2c2cbf59063d57fb51f9a7f76eeff6964373bfe7c1c673dc879000e4f7e46808',
  },
];

const failures: string[] = [];

for (const expectation of expectations) {
  if (expectation.preimage === null) {
    failures.push(`${expectation.label}: builder returned null`);
    continue;
  }

  if (expectation.preimage !== expectation.expectedPreimage) {
    failures.push(`${expectation.label}: preimage bytes changed\n  expected ${expectation.expectedPreimage}\n  actual   ${expectation.preimage}`);
    continue;
  }

  const digest = sha256Hex(expectation.preimage);
  const chainKey = keccak256(toUtf8Bytes(expectation.recordKey));

  if (digest !== expectation.expectedDigest) {
    failures.push(`${expectation.label}: digest ${digest} != documented ${expectation.expectedDigest}`);
    continue;
  }

  if (chainKey !== expectation.expectedChainKey) {
    failures.push(`${expectation.label}: on-chain key ${chainKey} != documented ${expectation.expectedChainKey}`);
    continue;
  }

  console.log(`  ok  ${expectation.label.padEnd(18)} ${digest}`);
}

if (failures.length > 0) {
  console.error('\nANCHORING.md worked example no longer matches the code:\n');
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error('\nEvery anchor already on-chain was written under the documented format. Do not "fix" the docs to match new bytes.');
  process.exit(1);
}

console.log(`\nAll ${expectations.length} anchor preimages match docs/ANCHORING.md section 3.`);
