import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { callApp, installBridgeShutdown, startBridge } from './bridge.js';

const PORT = Number(process.env['SHADER_STUDIO_MCP_PORT'] ?? 4310);

const paramValue = z.union([z.number(), z.boolean(), z.string()]);

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function main(): Promise<void> {
  const wss = await startBridge(PORT);
  installBridgeShutdown(wss);

  const server = new McpServer(
    { name: 'shader-studio', version: '1.0.0' },
    {
      instructions:
        'Contrôle une session Shader Studio ouverte dans le navigateur (dev only). ' +
        'Lance `pnpm dev`, ouvre http://localhost:4200, puis édite les shaders live, ' +
        'règle les uniforms et capture le canvas. Un seul onglet à la fois.',
    },
  );

  server.registerTool(
    'list_shaders',
    { description: 'Liste les shaders de la bibliothèque.' },
    async () => textResult(await callApp({ type: 'listShaders' })),
  );

  server.registerTool(
    'select_shader',
    {
      description: 'Ouvre un shader par son id.',
      inputSchema: { shaderId: z.string().describe('Identifiant du shader') },
    },
    async ({ shaderId }) => textResult(await callApp({ type: 'selectShader', shaderId })),
  );

  server.registerTool(
    'get_state',
    {
      description: 'Snapshot complet : draft, params live, presets, diagnostics, état dirty/saved.',
    },
    async () => textResult(await callApp({ type: 'getState' })),
  );

  server.registerTool(
    'set_fragment',
    {
      description: 'Remplace le fragment shader courant (recompile après ~400 ms).',
      inputSchema: { code: z.string().describe('Source GLSL du fragment shader') },
    },
    async ({ code }) => textResult(await callApp({ type: 'setFragment', code })),
  );

  server.registerTool(
    'set_vertex',
    {
      description: 'Remplace le vertex shader courant (recompile après ~400 ms).',
      inputSchema: { code: z.string().describe('Source GLSL du vertex shader') },
    },
    async ({ code }) => textResult(await callApp({ type: 'setVertex', code })),
  );

  server.registerTool(
    'set_controls',
    {
      description: 'Remplace le schéma JSON des contrôles/uniforms (onglet Config).',
      inputSchema: { text: z.string().describe('JSON du schéma de contrôles') },
    },
    async ({ text }) => textResult(await callApp({ type: 'setControls', text })),
  );

  server.registerTool(
    'set_param',
    {
      description: 'Règle un uniform live sans sauvegarder le shader.',
      inputSchema: {
        key: z.string().describe('Clé du contrôle (pas le nom uniform u_*)'),
        value: paramValue.describe('Valeur : number, boolean ou string (couleur hex)'),
      },
    },
    async ({ key, value }) => textResult(await callApp({ type: 'setParam', key, value })),
  );

  server.registerTool(
    'reset_params',
    { description: 'Remet tous les uniforms aux valeurs par défaut du schéma.' },
    async () => textResult(await callApp({ type: 'resetParams' })),
  );

  server.registerTool(
    'list_presets',
    { description: 'Liste les presets du shader ouvert.' },
    async () => textResult(await callApp({ type: 'listPresets' })),
  );

  server.registerTool(
    'apply_preset',
    {
      description: 'Applique un preset (params + éventuellement render settings).',
      inputSchema: { presetId: z.string().describe('Identifiant du preset') },
    },
    async ({ presetId }) => textResult(await callApp({ type: 'applyPreset', presetId })),
  );

  server.registerTool(
    'save_preset',
    {
      description: 'Capture les params live actuels dans un nouveau preset.',
      inputSchema: {
        name: z.string().describe('Nom du preset'),
        withRender: z
          .boolean()
          .optional()
          .describe('Inclure aussi les render settings (bloom) du draft'),
      },
    },
    async ({ name, withRender }) =>
      textResult(await callApp({ type: 'savePreset', name, withRender })),
  );

  server.registerTool(
    'delete_preset',
    {
      description: 'Supprime un preset persisté.',
      inputSchema: { presetId: z.string().describe('Identifiant du preset') },
    },
    async ({ presetId }) => textResult(await callApp({ type: 'deletePreset', presetId })),
  );

  server.registerTool(
    'save',
    { description: 'Sauvegarde le draft courant sur disque (Ctrl+S).' },
    async () => textResult(await callApp({ type: 'save' })),
  );

  server.registerTool(
    'revert',
    { description: 'Annule les modifications non sauvegardées du draft.' },
    async () => textResult(await callApp({ type: 'revert' })),
  );

  server.registerTool(
    'get_diagnostics',
    {
      description: 'Diagnostics de compilation (fragment, vertex, config) du draft courant.',
    },
    async () => textResult(await callApp({ type: 'getDiagnostics' })),
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture le rendu WebGL actuel en PNG.',
    },
    async () => {
      const frame = await callApp({ type: 'screenshot' }, 15_000);
      return {
        content: [
          { type: 'image' as const, data: frame.base64, mimeType: frame.mimeType },
          { type: 'text' as const, text: 'Capture du rendu shader actuel.' },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('[shader-studio-mcp] failed to start', error);
  process.exit(1);
});
