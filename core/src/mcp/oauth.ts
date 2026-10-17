import { randomUUID, createHash } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { safeEqual, sha256, type Signer } from './tokens.ts';

/**
 * Вход в Helm MCP (docs/helm-mcp.md, 3): минимальный сервер OAuth 2.1 для одного владельца, как ждут custom connectors
 * Claude. Регистрация клиента (DCR), код с PKCE S256, токены доступа и обновления. Разрешает владелец паролем
 * `MCP_OWNER_PASSWORD` на нашей странице. Всё без базы, на подписанных токенах (tokens.ts).
 */
export interface OAuthOptions {
  signer: Signer;
  password: string;
  /** Внешний адрес ядра без «/» в конце (https://your-core.example.com). */
  baseUrl: (c: Context) => string;
  now?: () => number;
}

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;
/** Неверных паролей за окно на всё ядро: пароль один, перебор с разных адресов тоже останавливается. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

export const MCP_PATH = '/mcp';

/** Адрес возврата: https или loopback, без фрагмента. */
function allowedRedirect(uri: unknown): boolean {
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function approvalPage(params: Record<string, string>, clientName: string, error?: string): string {
  const hidden = Object.entries(params).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Волна · Helm MCP</title><link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;background:#f4efe6;color:#2a2622}
@media(prefers-color-scheme:dark){body{background:#1b1917;color:#ece6dc}}
main{width:min(100%,400px)}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;opacity:.75}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border-radius:10px;border:1px solid #8886;margin-bottom:12px;background:transparent;color:inherit}
button{width:100%;padding:12px;font-size:16px;border-radius:10px;border:0;background:#c8642a;color:#fff;font-weight:600}
.err{color:#c0392b;opacity:1}</style></head><body><main>
<h1>Подключить ${escapeHtml(clientName)} к Штурвалу</h1>
<p>Клиент сможет читать треды Штурвала на твоём компьютере, писать в них, запускать и останавливать работу. Каждую запись он сначала покажет и спросит.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<input type="password" name="password" placeholder="Пароль владельца" autofocus required autocomplete="current-password">
<button type="submit">Разрешить</button></form></main></body></html>`;
}

type Fields = Record<string, string | undefined>;

/** Тело формы или JSON в плоские строки: OAuth шлёт формой, DCR — JSON. */
async function fields(c: Context): Promise<Fields> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = await c.req.json();
      return body && typeof body === 'object' ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : undefined])) : {};
    }
    const body = await c.req.parseBody();
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
  } catch { return {}; }
}

export function oauthRoutes(options: OAuthOptions) {
  const { signer, password, baseUrl } = options;
  const now = options.now ?? Date.now;
  const failures = { count: 0, since: now() };
  const tooManyFailures = () => {
    if (now() - failures.since > FAILURE_WINDOW_MS) Object.assign(failures, { count: 0, since: now() });
    return failures.count >= MAX_FAILURES;
  };

  const app = new Hono();

  const protectedResource = (c: Context) => {
    const base = baseUrl(c);
    return c.json({ resource: `${base}${MCP_PATH}`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['helm'], resource_name: 'Helm MCP' });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResource);

  const authorizationServer = (c: Context) => {
    const base = baseUrl(c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['helm'],
      authorization_response_iss_parameter_supported: true
    });
  };
  app.get('/.well-known/oauth-authorization-server', authorizationServer);
  app.get(`/.well-known/oauth-authorization-server${MCP_PATH}`, authorizationServer);
  app.get('/.well-known/openid-configuration', authorizationServer);

  app.post('/register', async c => {
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* пустое тело */ }
    const redirectUris = body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(allowedRedirect)) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https or loopback URLs.' }, 400);
    }
    const clientName = String(body.client_name ?? 'MCP client').slice(0, 80);
    const clientId = signer.sign('client', { n: clientName, r: redirectUris });
    return c.json({
      client_id: clientId, client_id_issued_at: Math.floor(now() / 1000), client_name: clientName, redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'
    }, 201);
  });

  const authorizeParams = (source: Fields): { error: string } | { error?: undefined; params: Record<string, string>; client: { n: string; r: string[] } } => {
    const params = {
      client_id: source.client_id ?? '', redirect_uri: source.redirect_uri ?? '', code_challenge: source.code_challenge ?? '',
      code_challenge_method: source.code_challenge_method ?? '', state: source.state ?? '', scope: source.scope ?? '', resource: source.resource ?? '',
      response_type: 'code'
    };
    const client = signer.verify('client', params.client_id) as { n: string; r: string[] } | null;
    if (!client) return { error: 'Неизвестный клиент. Удали коннектор в Claude и добавь заново.' };
    if (!client.r.includes(params.redirect_uri)) return { error: 'Этот адрес возврата не зарегистрирован для клиента.' };
    if (source.response_type !== undefined && source.response_type !== 'code') return { error: 'Поддерживается только response_type=code.' };
    if (params.code_challenge_method !== 'S256' || !params.code_challenge) return { error: 'Нужен PKCE с S256.' };
    return { params, client };
  };

  app.get('/authorize', c => {
    const parsed = authorizeParams(c.req.query());
    if (parsed.error !== undefined) return c.text(parsed.error, 400);
    return c.html(approvalPage(parsed.params, parsed.client.n));
  });

  app.post('/authorize', async c => {
    // Форма уходит только со своей страницы: чужой сайт не отправит пароль сюда от имени владельца.
    const origin = c.req.header('origin');
    if (origin && origin !== 'null' && origin !== baseUrl(c)) return c.text('Форма с чужого сайта.', 403);
    const source = await fields(c);
    const parsed = authorizeParams(source);
    if (parsed.error !== undefined) return c.text(parsed.error, 400);
    const { params, client } = parsed;
    if (tooManyFailures()) return c.html(approvalPage(params, client.n, 'Слишком много неверных попыток. Подожди 15 минут.'), 429);
    if (!safeEqual(source.password ?? '', password)) {
      failures.count += 1;
      return c.html(approvalPage(params, client.n, 'Неверный пароль.'), 401);
    }
    const code = signer.sign('code', { jti: randomUUID(), c: sha256(params.client_id), r: params.redirect_uri, ch: params.code_challenge }, CODE_TTL);
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    redirect.searchParams.set('iss', baseUrl(c));
    return c.redirect(redirect.toString(), 302);
  });

  app.post('/token', async c => {
    const body = await fields(c);
    const fail = (error: string, description: string) => c.json({ error, error_description: description }, 400);
    let client: string;
    if (body.grant_type === 'authorization_code') {
      const code = signer.verify('code', body.code);
      if (!code) return fail('invalid_grant', 'The code is invalid or expired.');
      if (code.c !== sha256(body.client_id ?? '') || code.r !== body.redirect_uri) return fail('invalid_grant', 'client_id or redirect_uri mismatch.');
      const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (challenge !== code.ch) return fail('invalid_grant', 'PKCE verification failed.');
      if (!signer.consumeOnce(`code:${code.jti}`, code.exp)) return fail('invalid_grant', 'The code was already used.');
      client = String(code.c);
    } else if (body.grant_type === 'refresh_token') {
      const refresh = signer.verify('refresh', body.refresh_token);
      if (!refresh) return fail('invalid_grant', 'The refresh token is invalid or expired.');
      if (body.client_id && refresh.c !== sha256(body.client_id)) return fail('invalid_grant', 'client_id mismatch.');
      client = String(refresh.c);
    } else {
      return fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
    return c.json({
      access_token: signer.sign('access', { c: client }, ACCESS_TTL), token_type: 'Bearer', expires_in: ACCESS_TTL,
      refresh_token: signer.sign('refresh', { c: client, jti: randomUUID() }, REFRESH_TTL), scope: 'helm'
    });
  });

  return app;
}

/** Охрана `/mcp`: токен доступа или 401 с адресом метаданных, по которому Claude начинает вход. */
export function requireAccessToken(signer: Signer, baseUrl: (c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (signer.verify('access', token)) return next();
    const metadata = `${baseUrl(c)}/.well-known/oauth-protected-resource${MCP_PATH}`;
    c.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${token ? ', error="invalid_token"' : ''}`);
    return c.json({ error: 'unauthorized', message: 'Sign in to Helm MCP first.' }, 401);
  };
}
