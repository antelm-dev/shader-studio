/**
 * Runtime parse helpers for session protocol messages.
 */

import type { Result } from '../validate/result';
import { fail, ok } from '../validate/result';
import {
  SessionCommandEnvelopeSchema,
  SessionCommandSchema,
  SessionCommandSchemas,
  SessionRejectionSchema,
  SessionSnapshotSchema,
  type SessionCommandSchemaType,
} from './schemas';
import type {
  SessionCommand,
  SessionCommandEnvelope,
  SessionRejection,
  SessionSnapshot,
} from './types';

export function parseSessionCommand(value: unknown): Result<SessionCommand> {
  const parsed = SessionCommandSchema.safeParse(value);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((issue) => issue.message));
  }
  return ok(parsed.data);
}

export function parseSessionCommandOfType<T extends SessionCommandSchemaType>(
  type: T,
  value: unknown,
): Result<SessionCommand & { type: T }> {
  const parsed = SessionCommandSchemas[type].safeParse(value);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((issue) => issue.message));
  }
  return ok(parsed.data as SessionCommand & { type: T });
}

export function parseSessionCommandEnvelope(value: unknown): Result<SessionCommandEnvelope> {
  const parsed = SessionCommandEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((issue) => issue.message));
  }
  return ok(parsed.data as unknown as SessionCommandEnvelope);
}

export function parseSessionSnapshot(value: unknown): Result<SessionSnapshot> {
  const parsed = SessionSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((issue) => issue.message));
  }
  return ok(parsed.data as unknown as SessionSnapshot);
}

export function parseSessionRejection(value: unknown): Result<SessionRejection> {
  const parsed = SessionRejectionSchema.safeParse(value);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((issue) => issue.message));
  }
  return ok(parsed.data as unknown as SessionRejection);
}
