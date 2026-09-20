import type { ITestValue, TestValueFlag } from '../models/MedicalDocument';

export const MAX_TEST_VALUES = 200;

export interface TestValueBounds {
  refLow?: number;
  refHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
}

/**
 * Flag rule, in priority order:
 *   outside [criticalLow, criticalHigh] -> 'critical'
 *   outside [refLow, refHigh]           -> 'low' | 'high'
 *   otherwise, or no bounds at all      -> 'normal'
 * Each bound is independent: a value with only refHigh set can be 'high' or 'normal', never 'low'.
 */
export const computeTestValueFlag = (value: number, bounds: TestValueBounds): TestValueFlag => {
  if (bounds.criticalLow !== undefined && value < bounds.criticalLow) return 'critical';
  if (bounds.criticalHigh !== undefined && value > bounds.criticalHigh) return 'critical';
  if (bounds.refLow !== undefined && value < bounds.refLow) return 'low';
  if (bounds.refHigh !== undefined && value > bounds.refHigh) return 'high';
  return 'normal';
};

export interface TestValuesParseResult {
  values?: ITestValue[];
  error?: string;
}

const BOUND_KEYS = ['refLow', 'refHigh', 'criticalLow', 'criticalHigh'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Accepts a number or a numeric string (multipart fields arrive as strings); blank means "not provided". */
const readOptionalNumber = (raw: unknown): { value?: number; invalid?: true } => {
  if (raw === undefined || raw === null || raw === '') {
    return {};
  }

  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;

  return Number.isFinite(parsed) ? { value: parsed } : { invalid: true };
};

/**
 * Parses the `testValues` multipart field (a JSON string) or an already-parsed array into validated
 * ITestValue entries with server-computed flags. Any client-supplied `flag` is ignored.
 */
export const parseTestValues = (raw: unknown): TestValuesParseResult => {
  if (raw === undefined || raw === null || raw === '') {
    return { values: [] };
  }

  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: 'testValues must be a JSON array' };
    }
  }

  if (!Array.isArray(parsed)) {
    return { error: 'testValues must be a JSON array' };
  }

  if (parsed.length > MAX_TEST_VALUES) {
    return { error: `testValues may contain at most ${MAX_TEST_VALUES} entries` };
  }

  const values: ITestValue[] = [];

  for (let index = 0; index < parsed.length; index += 1) {
    const entry: unknown = parsed[index];
    const label = `testValues[${index}]`;

    if (!isRecord(entry)) {
      return { error: `${label} must be an object` };
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const unit = typeof entry.unit === 'string' ? entry.unit.trim() : '';

    if (!name || name.length > 80) {
      return { error: `${label}.name must be 1 to 80 characters` };
    }

    if (!unit || unit.length > 20) {
      return { error: `${label}.unit must be 1 to 20 characters` };
    }

    const value = readOptionalNumber(entry.value);

    if (value.invalid || value.value === undefined) {
      return { error: `${label}.value must be a finite number` };
    }

    const bounds: TestValueBounds = {};

    for (const key of BOUND_KEYS) {
      const bound = readOptionalNumber(entry[key]);

      if (bound.invalid) {
        return { error: `${label}.${key} must be a finite number` };
      }

      if (bound.value !== undefined) {
        bounds[key] = bound.value;
      }
    }

    if (bounds.refLow !== undefined && bounds.refHigh !== undefined && bounds.refLow > bounds.refHigh) {
      return { error: `${label}: refLow must not exceed refHigh` };
    }

    if (bounds.criticalLow !== undefined && bounds.criticalHigh !== undefined && bounds.criticalLow > bounds.criticalHigh) {
      return { error: `${label}: criticalLow must not exceed criticalHigh` };
    }

    if (bounds.criticalLow !== undefined && bounds.refLow !== undefined && bounds.criticalLow > bounds.refLow) {
      return { error: `${label}: criticalLow must not exceed refLow` };
    }

    if (bounds.criticalHigh !== undefined && bounds.refHigh !== undefined && bounds.criticalHigh < bounds.refHigh) {
      return { error: `${label}: criticalHigh must not be below refHigh` };
    }

    values.push({ name, value: value.value, unit, ...bounds, flag: computeTestValueFlag(value.value, bounds) });
  }

  return { values };
};
