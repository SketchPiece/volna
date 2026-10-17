import { readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { MCP_PATH, oauthRoutes, requireAccessToken } from './oauth.ts';
import { INSTRUCTIONS, mcpTools, type McpTool, type McpToolsOptions } from './tools.ts';
import type { Signer } from './tokens.ts';

/**
 * Helm MCP в ядре (docs/helm-mcp.md): удалённый MCP-сервер для Claude владельца (Desktop, мобильный, claude.ai).
 * Streamable HTTP без сессий: каждый `POST /mcp` — один JSON-RPC запрос (или пачка), ответ JSON, без SSE. Своих методов
 * немного: initialize, ping, tools/list, tools/call. Состояния нет, кроме одноразовых кодов в Signer.
 */
export interface HelmMcpOptions extends Omit<McpToolsOptions, 'signer'> {
  signer: Signer;
  password: string;
  /** Внешний адрес ядра (MCP_PUBLIC_URL или домен Railway); без него — из запроса. */
  publicUrl?: string;
  log: Logger;
  version?: string;
}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CALL_TIMEOUT_MS = 55_000;
/** Иконка «Штурвала» (docs/design/icons/helm): её показывает Claude у коннектора. */
const ICON = readFileSync(new URL('../../assets/helm-icon.png', import.meta.url));
const ICON_PATHS = ['/icon.png', '/favicon.ico', '/favicon.png', '/apple-touch-icon.png'];

const rpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional()
});

type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

/** Адрес ядра снаружи: Railway за прокси, поэтому схему берём из `x-forwarded-proto`. */
export function publicBase(publicUrl: string | undefined) {
  return (c: Context) => {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
    return `${proto}://${c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host}`;
  };
}

/** Пути Helm MCP: вход, иконка и сам `/mcp`. */
export const isHelmMcpPath = (path: string) => path === MCP_PATH || ICON_PATHS.includes(path) || ['/authorize', '/token', '/register'].includes(path) || path.startsWith('/.well-known/oauth-') || path === '/.well-known/openid-configuration';

export function helmMcpRoutes(options: HelmMcpOptions) {
  const { signer, log } = options;
  const baseUrl = publicBase(options.publicUrl);
  const tools = mcpTools(options);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const listed = tools.map(describe);

  async function handle(message: unknown, signal: AbortSignal, base: string): Promise<RpcResponse | null> {
    const parsed = rpcRequest.safeParse(message);
    if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } };
    const { id, method, params = {} } = parsed.data;
    // Уведомления (без id) ответа не ждут: initialized, cancelled.
    if (id === undefined) return null;
    const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    const error = (code: number, text: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'helm-mcp', title: 'Helm (Волна)', version: options.version ?? '1.0.0', icons: [{ src: `${base}/icon.png`, mimeType: 'image/png', sizes: ['256x256'] }] },
          instructions: INSTRUCTIONS
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: listed });
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
        if (!tool) return error(-32602, `Unknown tool: ${String(params.name)}`);
        const args = tool.input.safeParse(params.arguments ?? {});
        if (!args.success) return reply({ isError: true, content: [{ type: 'text', text: `Invalid arguments: ${z.prettifyError(args.error)}` }] });
        const started = Date.now();
        try {
          const result = await tool.run(args.data as Record<string, unknown>, AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]));
          // Содержимое не пишем: в нём тексты тредов и сообщения владельца.
          log.info('mcp.call', { tool: tool.name, ok: !result.isError, ms: Date.now() - started });
          return reply(result);
        } catch (failure) {
          log.warn('mcp.call.failed', { tool: tool.name, error: failure instanceof Error ? failure.name : 'error' });
          return reply({ isError: true, content: [{ type: 'text', text: 'Helm did not answer in time. Try again.' }] });
        }
      }
      default: return error(-32601, `Method not found: ${method}`);
    }
  }

  const app = new Hono();
  app.route('/', oauthRoutes({ signer, password: options.password, baseUrl }));
  for (const path of ICON_PATHS) app.get(path, c => {
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(ICON, 200, { 'Content-Type': 'image/png' });
  });
  const guard = requireAccessToken(signer, baseUrl);
  app.post(MCP_PATH, guard, bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'Too large.' }, 413) }), async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }, 400); }
    const signal = c.req.raw.signal;
    const base = baseUrl(c);
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.slice(0, 20).map(m => handle(m, signal, base)))).filter(Boolean);
      return answers.length ? c.json(answers) : c.body(null, 202);
    }
    const answer = await handle(body, signal, base);
    return answer ? c.json(answer) : c.body(null, 202);
  });
  // Без сессий и SSE: GET-поток и DELETE сессии не нужны.
  app.on(['GET', 'DELETE'], MCP_PATH, guard, c => {
    c.header('Allow', 'POST');
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }, 405);
  });
  return app;
}

function describe(tool: McpTool) {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema, annotations: { title: tool.title, ...tool.annotations } };
}
