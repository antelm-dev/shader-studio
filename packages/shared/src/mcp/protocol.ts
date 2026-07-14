/**
 * Wire protocol between the MCP server (`mcp/server.ts`) and the browser tab
 * it drives (`app/core/mcp-bridge.ts`).
 *
 * The MCP server is the WebSocket server; the browser is the client. It opens
 * with a `Handshake` identifying the session (and proving it holds the bridge
 * token), then every exchange is a request/response pair correlated by `id`.
 *
 * `COMMAND_SCHEMAS` is the single source of truth for the whole command
 * surface: one Zod payload/result schema pair per command. Every other type in
 * this file — the request union, the result map, the discriminated request
 * schema used to validate what arrives over the wire — is derived from it, so
 * a new command only has to be added in one place. This replaces the old
 * hand-written `CommandSpecs` interface (plain types, no runtime check) with
 * something both sides actually validate against.
 */

import { z } from 'zod';

import { LIMITS } from '../validate';
// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Sizes specific to the MCP wire protocol. Reuses `LIMITS` where a limit already exists. */
export const MCP_LIMITS = {
  /** A single document edit's replacement text. Same ceiling as a whole source file. */
  sourceLength: LIMITS.sourceLength,
  maxEditsPerPatch: 200,
  maxParamsPerRequest: LIMITS.controlCount,
  maxDocumentIdLength: 128,
  maxShaderIdLength: LIMITS.idLength,
  maxCapabilities: 32,
  /** `WebSocketServer`'s `maxPayload`. Comfortably above a max-size patch, well below "unbounded". */
  maxMessageBytes: 4 * 1024 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

const paramValueSchema = z.union([z.number(), z.boolean(), z.string()]);
const shaderParamsSchema = z.record(z.string(), paramValueSchema);

const thumbnailMetaSchema = z.object({ ext: z.string(), updatedAt: z.string() });

const shaderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  updatedAt: z.string(),
  controlCount: z.number().int().nonnegative(),
  presetCount: z.number().int().nonnegative(),
  thumbnail: thumbnailMetaSchema.nullable(),
});

const controlBaseShape = {
  key: z.string(),
  label: z.string().optional(),
  folder: z.string().optional(),
};

const numberControlSchema = z.object({
  ...controlBaseShape,
  type: z.literal('number'),
  default: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number().optional(),
});
const booleanControlSchema = z.object({
  ...controlBaseShape,
  type: z.literal('boolean'),
  default: z.boolean(),
});
const colorControlSchema = z.object({
  ...controlBaseShape,
  type: z.literal('color'),
  default: z.string(),
});
const selectControlSchema = z.object({
  ...controlBaseShape,
  type: z.literal('select'),
  default: z.number(),
  options: z.record(z.string(), z.number()),
});

const shaderControlSchema = z.discriminatedUnion('type', [
  numberControlSchema,
  booleanControlSchema,
  colorControlSchema,
  selectControlSchema,
]);

const bloomSettingsSchema = z.object({
  enabled: z.boolean(),
  strength: z.number(),
  radius: z.number(),
  threshold: z.number(),
});
const renderSettingsSchema = z.object({ bloom: bloomSettingsSchema });

const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  values: shaderParamsSchema,
  render: renderSettingsSchema.optional(),
});

const textureChannelSchema = z.object({
  ext: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  wrap: z.enum(['repeat', 'clamp', 'mirror']),
  filter: z.enum(['linear', 'nearest']),
  flipY: z.boolean(),
});
const textureChannelsSchema = z.tuple([
  textureChannelSchema,
  textureChannelSchema,
  textureChannelSchema,
  textureChannelSchema,
]);

const shaderRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  controls: z.array(shaderControlSchema),
  render: renderSettingsSchema,
  channels: textureChannelsSchema,
  thumbnail: thumbnailMetaSchema.nullable(),
  fragment: z.string(),
  vertex: z.string(),
  presets: z.array(presetSchema),
});

export const McpDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  line: z.number().int(),
  message: z.string(),
  source: z.enum(['fragment', 'vertex', 'config']),
  docId: z.string().optional(),
  docName: z.string().optional(),
});
export type McpDiagnostic = z.infer<typeof McpDiagnosticSchema>;

export const McpScreenshotSchema = z.object({
  base64: z.string(),
  mimeType: z.literal('image/png'),
});
export type McpScreenshot = z.infer<typeof McpScreenshotSchema>;

/** Everything worth knowing about the session currently open in the browser. Legacy shape, kept for the pre-project tools. */
export const McpStateSnapshotSchema = z.object({
  selectedId: z.string().nullable(),
  shaders: z.array(shaderSummarySchema),
  record: shaderRecordSchema.nullable(),
  draft: z
    .object({
      fragment: z.string(),
      vertex: z.string(),
      controlsText: z.string(),
      render: renderSettingsSchema,
    })
    .nullable(),
  controls: z.array(shaderControlSchema),
  params: shaderParamsSchema,
  presets: z.array(presetSchema),
  activePresetId: z.string().nullable(),
  dirty: z.boolean(),
  hasErrors: z.boolean(),
  diagnostics: z.array(McpDiagnosticSchema),
});
export type McpStateSnapshot = z.infer<typeof McpStateSnapshotSchema>;

// ---------------------------------------------------------------------------
// Project-aware schemas
// ---------------------------------------------------------------------------

export const TextEditSchema = z
  .object({
    documentId: z.string().min(1).max(MCP_LIMITS.maxDocumentIdLength),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    text: z.string().max(MCP_LIMITS.sourceLength),
  })
  .refine((edit) => edit.end >= edit.start, { message: 'end must be >= start' });
export type TextEdit = z.infer<typeof TextEditSchema>;

const passKindSchema = z.enum(['image', 'common', 'buffer']);
const bufferSlotSchema = z.enum(['A', 'B', 'C', 'D']);
const documentKindSchema = z.enum(['pass', 'file', 'vertex', 'config']);

/**
 * A document's shape and length, deliberately without its `source` — this is
 * what lets `get_project` describe a whole project without ever shipping a
 * full GLSL file an agent did not ask for. `get_document` is what returns the
 * source, for exactly the one document that was asked about.
 */
const documentSummarySchema = z.object({
  id: z.string(),
  kind: documentKindSchema,
  name: z.string(),
  sourceLength: z.number().int().nonnegative(),
  passKind: passKindSchema.optional(),
  slot: bufferSlotSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

export const ProjectSnapshotSchema = z.object({
  shaderId: z.string(),
  name: z.string(),
  revision: z.number().int(),
  dirty: z.boolean(),
  documents: z.array(documentSummarySchema),
  controls: z.array(shaderControlSchema),
  params: shaderParamsSchema,
  presets: z.array(presetSchema),
  activePresetId: z.string().nullable(),
  render: renderSettingsSchema,
  diagnostics: z.array(McpDiagnosticSchema),
  hasErrors: z.boolean(),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

export const DocumentSnapshotSchema = z.object({
  id: z.string(),
  kind: documentKindSchema,
  name: z.string(),
  source: z.string(),
  revision: z.number().int(),
  diagnostics: z.array(McpDiagnosticSchema),
});
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;

export const PatchResultSchema = z.object({
  revision: z.number().int(),
  diagnostics: z.array(McpDiagnosticSchema),
});
export type PatchResult = z.infer<typeof PatchResultSchema>;

export const SetParamsResultSchema = z.object({
  applied: z.array(z.string()),
  errors: z.record(z.string(), z.string()),
  params: shaderParamsSchema,
});
export type SetParamsResult = z.infer<typeof SetParamsResultSchema>;

export const CompileResultSchema = z.object({
  revision: z.number().int(),
  diagnostics: z.array(McpDiagnosticSchema),
  hasErrors: z.boolean(),
});
export type CompileResult = z.infer<typeof CompileResultSchema>;

export const RenderFrameResultSchema = z.object({
  base64: z.string(),
  mimeType: z.literal('image/png'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  time: z.number(),
});
export type RenderFrameResult = z.infer<typeof RenderFrameResultSchema>;

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

/**
 * Zod 4 infers `z.object({})` as `Record<string, never>`. Intersecting that
 * with `{type: ...}` makes even the discriminator illegal, so give the parsed
 * empty payload an explicit, structurally empty marker shape for command types.
 */
type NoPayload = { readonly __noPayload?: never };
const NoPayloadSchema = z.object({}) as z.ZodType<NoPayload>;

const shaderIdSchema = z.string().min(1).max(MCP_LIMITS.maxShaderIdLength);
/**
 * Every new project-aware command except `apply_shader_patch` (which the task
 * spec explicitly requires it on) treats `shaderId` as an assertion rather
 * than a selector — the app drives exactly one open shader at a time, and
 * `select_shader` is what changes it. Sending it is optional; sending the
 * wrong one is a `NOT_FOUND` error rather than a silent switch.
 */
const optionalShaderIdPayloadSchema = z.object({ shaderId: shaderIdSchema.optional() });

export const COMMAND_SCHEMAS = {
  // --- Existing commands, now schema-backed ---------------------------------
  listShaders: { payload: NoPayloadSchema, result: z.array(shaderSummarySchema) },
  selectShader: {
    payload: z.object({ shaderId: shaderIdSchema }),
    result: McpStateSnapshotSchema,
  },
  getState: { payload: NoPayloadSchema, result: McpStateSnapshotSchema },
  /** Compatibility tool — prefer `apply_shader_patch`. */
  setFragment: {
    payload: z.object({ code: z.string().max(LIMITS.sourceLength) }),
    result: z.array(McpDiagnosticSchema),
  },
  /** Compatibility tool — prefer `apply_shader_patch`. */
  setVertex: {
    payload: z.object({ code: z.string().max(LIMITS.sourceLength) }),
    result: z.array(McpDiagnosticSchema),
  },
  setControls: {
    payload: z.object({ text: z.string().max(LIMITS.sourceLength) }),
    result: z.array(McpDiagnosticSchema),
  },
  setParam: {
    payload: z.object({ key: z.string().max(LIMITS.keyLength), value: paramValueSchema }),
    result: shaderParamsSchema,
  },
  resetParams: { payload: NoPayloadSchema, result: shaderParamsSchema },
  listPresets: { payload: NoPayloadSchema, result: z.array(presetSchema) },
  applyPreset: {
    payload: z.object({ presetId: z.string().max(LIMITS.idLength) }),
    result: McpStateSnapshotSchema,
  },
  savePreset: {
    payload: z.object({
      name: z.string().max(LIMITS.nameLength),
      withRender: z.boolean().optional(),
    }),
    result: z.array(presetSchema),
  },
  deletePreset: {
    payload: z.object({ presetId: z.string().max(LIMITS.idLength) }),
    result: z.array(presetSchema),
  },
  save: { payload: NoPayloadSchema, result: McpStateSnapshotSchema },
  revert: { payload: NoPayloadSchema, result: McpStateSnapshotSchema },
  screenshot: { payload: NoPayloadSchema, result: McpScreenshotSchema },
  getDiagnostics: { payload: NoPayloadSchema, result: z.array(McpDiagnosticSchema) },

  // --- Project-aware commands ------------------------------------------------
  getProject: { payload: optionalShaderIdPayloadSchema, result: ProjectSnapshotSchema },
  getDocument: {
    payload: z.object({
      shaderId: shaderIdSchema.optional(),
      documentId: z.string().min(1).max(MCP_LIMITS.maxDocumentIdLength),
    }),
    result: DocumentSnapshotSchema,
  },
  applyShaderPatch: {
    payload: z.object({
      shaderId: shaderIdSchema,
      baseRevision: z.number().int().min(0),
      edits: z.array(TextEditSchema).min(1).max(MCP_LIMITS.maxEditsPerPatch),
    }),
    result: PatchResultSchema,
  },
  setParams: {
    payload: z.object({
      shaderId: shaderIdSchema.optional(),
      params: z
        .record(z.string().max(LIMITS.keyLength), paramValueSchema)
        .refine((params) => Object.keys(params).length > 0, 'params must not be empty')
        .refine(
          (params) => Object.keys(params).length <= MCP_LIMITS.maxParamsPerRequest,
          `at most ${MCP_LIMITS.maxParamsPerRequest} params per request`,
        ),
    }),
    result: SetParamsResultSchema,
  },
  compileProject: { payload: optionalShaderIdPayloadSchema, result: CompileResultSchema },
  renderFrame: {
    payload: z.object({
      shaderId: shaderIdSchema.optional(),
      time: z.number().min(0).max(1_000_000).optional(),
      width: z.number().int().min(1).max(4096).optional(),
      height: z.number().int().min(1).max(4096).optional(),
      params: z.record(z.string().max(LIMITS.keyLength), paramValueSchema).optional(),
    }),
    result: RenderFrameResultSchema,
  },
} as const satisfies Record<string, { payload: z.ZodTypeAny; result: z.ZodTypeAny }>;

export type ControllerCommandType = keyof typeof COMMAND_SCHEMAS;

/** The result a command resolves to, looked up by its `type`. */
export type ControllerResultMap = {
  [K in ControllerCommandType]: z.infer<(typeof COMMAND_SCHEMAS)[K]['result']>;
};

/** The discriminated union of every command, derived from `COMMAND_SCHEMAS`. */
export type ControllerCommand = {
  [K in ControllerCommandType]: { type: K } & z.infer<(typeof COMMAND_SCHEMAS)[K]['payload']>;
}[ControllerCommandType];

export type ControllerRequest = { id: string } & ControllerCommand;

/** Tools that only read state. Used to pick MCP annotations without repeating the list by hand. */
export const READ_ONLY_COMMANDS: ReadonlySet<ControllerCommandType> = new Set([
  'listShaders',
  'getState',
  'listPresets',
  'getDiagnostics',
  'screenshot',
  'getProject',
  'getDocument',
]);

function requestSchemaFor<T extends ControllerCommandType>(type: T) {
  return z
    .object({ id: z.string().min(1).max(64), type: z.literal(type) })
    .extend((COMMAND_SCHEMAS[type].payload as z.ZodObject<z.ZodRawShape>).shape);
}

const REQUEST_SCHEMA_MEMBERS = (Object.keys(COMMAND_SCHEMAS) as ControllerCommandType[]).map(
  (type) => requestSchemaFor(type),
);

/**
 * Validates a raw parsed JSON value as a `ControllerRequest`.
 *
 * The one deliberate cast in this file: `z.discriminatedUnion` wants a typed
 * tuple of members, and building that list from `COMMAND_SCHEMAS` dynamically
 * (so the two can never drift apart) means TypeScript cannot verify the tuple
 * shape at the call site. Runtime behaviour is exactly what a hand-written
 * union of the same members would do — `.parse()`/`.safeParse()` below is what
 * actually protects both processes from a malformed message, not this type.
 */
export const ControllerRequestSchema = z.discriminatedUnion(
  'type',
  REQUEST_SCHEMA_MEMBERS as unknown as [
    (typeof REQUEST_SCHEMA_MEMBERS)[number],
    ...(typeof REQUEST_SCHEMA_MEMBERS)[number][],
  ],
) as unknown as z.ZodType<ControllerRequest>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const McpErrorCodeSchema = z.enum([
  'STALE_REVISION',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'BUSY',
  'UNAUTHORIZED',
  'INTERNAL',
]);
export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;

export const McpErrorSchema = z.object({
  code: McpErrorCodeSchema,
  message: z.string(),
  /** Present on `STALE_REVISION`: what the caller should have sent. */
  currentRevision: z.number().int().optional(),
});
export type McpError = z.infer<typeof McpErrorSchema>;

export function mcpError(
  code: McpErrorCode,
  message: string,
  extra?: { currentRevision?: number },
): McpError {
  return { code, message, ...(extra?.currentRevision !== undefined ? extra : {}) };
}

/** The envelope shape only — the app validates `result` against the specific command's schema once it knows, from `pending`, which command this `id` was for. */
export const AppResponseEnvelopeSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: McpErrorSchema }),
]);
export type AppResponseEnvelope = z.infer<typeof AppResponseEnvelopeSchema>;

export type AppResponse<T extends ControllerCommandType = ControllerCommandType> =
  | { id: string; ok: true; result: ControllerResultMap[T] }
  | { id: string; ok: false; error: McpError };

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export const MCP_BRIDGE_PROTOCOL_VERSION = 2;

/**
 * Only the browser tab ("app") connects to the bridge — the MCP server *is*
 * the WebSocket server. The handshake is what replaces "any process that can
 * open a socket to 127.0.0.1" with an explicit, checkable identity: a token
 * proving it is the intended app, a session id the bridge can name in logs and
 * rejection messages, and a capability list for future negotiation.
 */
export const HandshakeSchema = z.object({
  kind: z.literal('hello'),
  role: z.literal('app'),
  protocolVersion: z.number().int(),
  appVersion: z.string().min(1).max(32),
  sessionId: z.string().min(1).max(64),
  token: z.string().min(1).max(256),
  capabilities: z.array(z.string().max(64)).max(MCP_LIMITS.maxCapabilities),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

export const HandshakeAckSchema = z.object({
  kind: z.literal('hello-ack'),
  sessionId: z.string(),
  protocolVersion: z.number().int(),
});
export type HandshakeAck = z.infer<typeof HandshakeAckSchema>;

export const HandshakeRejectedSchema = z.object({
  kind: z.literal('hello-rejected'),
  reason: z.string(),
});
export type HandshakeRejected = z.infer<typeof HandshakeRejectedSchema>;

export function isHandshakeMessage(value: unknown): value is { kind: 'hello' } {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'hello'
  );
}
