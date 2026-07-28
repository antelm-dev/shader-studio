/**
 * Zod schemas for session protocol wire validation.
 */

import { z } from 'zod';

import { LIMITS } from '../validate/limits';
import { SESSION_CLIENT_ROLES, SESSION_DOCUMENT_KINDS } from './types';
import { SESSION_PROTOCOL_VERSION } from './version';

export const SESSION_LIMITS = {
  idLength: 128,
  labelLength: 64,
  maxOpenDocuments: 64,
  maxDocuments: 128,
  maxEditsPerPatch: 200,
  maxParamsPerRequest: LIMITS.controlCount,
  maxDiagnostics: 500,
  maxMessageBytes: 4 * 1024 * 1024,
  sourceLength: LIMITS.sourceLength,
  keyLength: LIMITS.keyLength,
} as const;

const idString = z.string().min(1).max(SESSION_LIMITS.idLength);
const documentIdSchema = z.string().min(1).max(SESSION_LIMITS.idLength);
const paramValueSchema = z.union([z.number(), z.boolean(), z.string()]);
const paramsSchema = z.record(z.string().max(SESSION_LIMITS.keyLength), paramValueSchema);
const viewStateSchema = z.record(z.string(), z.unknown()).nullable();

const diagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  line: z.number().int(),
  message: z.string(),
  source: z.enum(['fragment', 'vertex', 'config']),
  docId: z.string().optional(),
  docName: z.string().optional(),
});

const documentKindSchema = z.enum(
  SESSION_DOCUMENT_KINDS as unknown as [string, ...string[]],
) as z.ZodType<(typeof SESSION_DOCUMENT_KINDS)[number]>;

const clientRoleSchema = z.enum(
  SESSION_CLIENT_ROLES as unknown as [string, ...string[]],
) as z.ZodType<(typeof SESSION_CLIENT_ROLES)[number]>;

const compileStatusSchema = z.enum(['idle', 'compiling', 'ok', 'error']);

const textEditSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string().max(SESSION_LIMITS.sourceLength),
});

const focusTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: documentIdSchema }),
  z.object({ kind: z.literal('surface'), surfaceId: idString }),
  z.object({ kind: z.literal('shader'), shaderId: idString }),
]);

const draftMetaSchema = z.object({
  controlsText: z.string().max(SESSION_LIMITS.sourceLength),
  render: z.record(z.string(), z.unknown()),
});

const documentSeedSchema = z.object({
  documentId: documentIdSchema,
  kind: documentKindSchema,
  name: z.string().min(1).max(LIMITS.nameLength),
  language: z.enum(['glsl', 'json']),
  source: z.string().max(SESSION_LIMITS.sourceLength),
  viewState: viewStateSchema.optional().default(null),
});

export const SessionCommandSchemas = {
  hello: z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    role: clientRoleSchema,
    label: z.string().max(SESSION_LIMITS.labelLength).optional(),
    clientId: idString.optional(),
  }),
  heartbeat: z.object({ type: z.literal('heartbeat') }),
  disconnect: z.object({ type: z.literal('disconnect') }),
  requestResync: z.object({
    type: z.literal('requestResync'),
    reason: z.string().max(256).optional(),
  }),
  selectShader: z.object({
    type: z.literal('selectShader'),
    shaderId: idString.nullable(),
  }),
  openDocument: z.object({ type: z.literal('openDocument'), documentId: documentIdSchema }),
  closeDocument: z.object({ type: z.literal('closeDocument'), documentId: documentIdSchema }),
  selectDocument: z.object({ type: z.literal('selectDocument'), documentId: documentIdSchema }),
  moveDocument: z.object({
    type: z.literal('moveDocument'),
    documentId: documentIdSchema,
    targetClientId: idString,
    viewState: viewStateSchema.optional(),
  }),
  claimOwnership: z.object({ type: z.literal('claimOwnership'), documentId: documentIdSchema }),
  releaseOwnership: z.object({
    type: z.literal('releaseOwnership'),
    documentId: documentIdSchema,
  }),
  editDocument: z.object({
    type: z.literal('editDocument'),
    documentId: documentIdSchema,
    baseRevision: z.number().int().min(0),
    source: z.string().max(SESSION_LIMITS.sourceLength),
    viewState: viewStateSchema.optional(),
  }),
  patchDocument: z.object({
    type: z.literal('patchDocument'),
    documentId: documentIdSchema,
    baseRevision: z.number().int().min(0),
    edits: z.array(textEditSchema).min(1).max(SESSION_LIMITS.maxEditsPerPatch),
    viewState: viewStateSchema.optional(),
  }),
  setParams: z.object({
    type: z.literal('setParams'),
    baseRevision: z.number().int().min(0),
    params: paramsSchema,
  }),
  setParam: z.object({
    type: z.literal('setParam'),
    baseRevision: z.number().int().min(0),
    key: z.string().min(1).max(SESSION_LIMITS.keyLength),
    value: paramValueSchema,
  }),
  resetParams: z.object({
    type: z.literal('resetParams'),
    baseRevision: z.number().int().min(0),
    params: paramsSchema,
  }),
  applyPreset: z.object({
    type: z.literal('applyPreset'),
    presetId: idString,
    params: paramsSchema,
    baseRevision: z.number().int().min(0),
  }),
  save: z.object({ type: z.literal('save') }),
  revert: z.object({ type: z.literal('revert') }),
  requestFocus: z.object({ type: z.literal('requestFocus'), target: focusTargetSchema }),
  reportDiagnostics: z.object({
    type: z.literal('reportDiagnostics'),
    diagnostics: z.array(diagnosticSchema).max(SESSION_LIMITS.maxDiagnostics),
    compileRevision: z.number().int().min(0),
    compileStatus: compileStatusSchema,
  }),
  reportCompilation: z.object({
    type: z.literal('reportCompilation'),
    compileStatus: compileStatusSchema,
    compileRevision: z.number().int().min(0),
  }),
  replaceDraft: z.object({
    type: z.literal('replaceDraft'),
    shaderId: idString.nullable(),
    documents: z.array(documentSeedSchema).max(SESSION_LIMITS.maxDocuments),
    openDocumentIds: z.array(documentIdSchema).max(SESSION_LIMITS.maxOpenDocuments),
    activeDocumentId: documentIdSchema.nullable(),
    params: paramsSchema,
    draftMeta: draftMetaSchema.nullable().optional(),
    dirty: z.boolean().optional(),
  }),
} as const;

export type SessionCommandSchemaType = keyof typeof SessionCommandSchemas;

const commandSchemaMembers = (Object.keys(SessionCommandSchemas) as SessionCommandSchemaType[]).map(
  (type) => SessionCommandSchemas[type],
);

/** Same dynamic-union cast pattern as `ControllerRequestSchema` in mcp/protocol. */
export const SessionCommandSchema = z.discriminatedUnion(
  'type',
  commandSchemaMembers as unknown as [
    (typeof commandSchemaMembers)[number],
    ...(typeof commandSchemaMembers)[number][],
  ],
) as unknown as z.ZodType<import('./types').SessionCommand>;

export const SessionCommandEnvelopeSchema = z.object({
  kind: z.literal('command'),
  protocolVersion: z.literal(SESSION_PROTOCOL_VERSION),
  sessionId: idString,
  clientId: idString,
  commandId: idString,
  seq: z.number().int().min(0),
  command: SessionCommandSchema,
});

export const SessionDocumentStateSchema = z.object({
  documentId: documentIdSchema,
  kind: documentKindSchema,
  name: z.string().min(1).max(LIMITS.nameLength),
  language: z.enum(['glsl', 'json']),
  source: z.string().max(SESSION_LIMITS.sourceLength),
  revision: z.number().int().min(0),
  ownerClientId: idString.nullable(),
  viewState: viewStateSchema,
});

export const SessionSnapshotSchema = z.object({
  protocolVersion: z.literal(SESSION_PROTOCOL_VERSION),
  sessionId: idString,
  sessionRevision: z.number().int().min(0),
  shaderId: idString.nullable(),
  dirty: z.boolean(),
  saving: z.boolean(),
  activeDocumentId: documentIdSchema.nullable(),
  openDocumentIds: z.array(documentIdSchema),
  documents: z.record(z.string(), SessionDocumentStateSchema),
  params: paramsSchema,
  paramsRevision: z.number().int().min(0),
  diagnostics: z.array(diagnosticSchema),
  compileRevision: z.number().int().min(0).nullable(),
  compileStatus: compileStatusSchema,
  clients: z.array(
    z.object({
      clientId: idString,
      role: clientRoleSchema,
      label: z.string().optional(),
      connectedAt: z.number(),
      lastSeenAt: z.number(),
    }),
  ),
  draftMeta: draftMetaSchema.nullable(),
});

export const SessionRejectionSchema = z.object({
  code: z.enum([
    'PROTOCOL_MISMATCH',
    'UNAUTHORIZED',
    'NOT_CONNECTED',
    'STALE_REVISION',
    'NOT_OWNER',
    'ALREADY_OWNED',
    'NOT_FOUND',
    'INVALID_COMMAND',
    'SAVE_IN_PROGRESS',
    'BUSY',
    'VALIDATION_ERROR',
  ]),
  message: z.string(),
  commandId: z.string().optional(),
  commandType: z.string().optional(),
  currentRevision: z.number().int().optional(),
  sessionRevision: z.number().int().optional(),
  document: SessionDocumentStateSchema.optional(),
  snapshot: SessionSnapshotSchema.optional(),
  supportedProtocolVersions: z.array(z.number().int()).optional(),
});

export {
  diagnosticSchema as SessionDiagnosticSchema,
  paramsSchema as SessionParamsSchema,
  viewStateSchema as SessionViewStateSchema,
  draftMetaSchema as SessionDraftMetaSchema,
  focusTargetSchema as SessionFocusTargetSchema,
};
