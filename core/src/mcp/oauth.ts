import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { safeEqual, sha256, type Signer } from './tokens.ts';
import { createPage, loginPage, messagePage, passwordPage, readyPage } from './pages.ts';
import { PUBLIC_KEY_ALGORITHMS, verifyAssertion, verifyRegistration, type Expected, type PasskeyStore } from './passkey.ts';

/**
 * Вход в Helm MCP (docs/helm-mcp.md, 3): минимальный сервер OAuth 2.1 для одного владельца, как ждут custom connectors
 * Claude. Регистрация клиента (DCR), код с PKCE S256, токены доступа и обновления. Разрешает владелец на нашей странице
 * пасскеем; пароль `MCP_OWNER_PASSWORD` годится один раз — чтобы создать пасскей (здесь же или на `/passkey`), после
 * этого сервер его не принимает (passkey.ts). Кроме файла с пасскеем, всё на подписанных токенах (tokens.ts).
 */
export interface OAuthOptions {
  signer: Signer;
  password: string;
  passkeys: PasskeyStore;
  /** Внешний адрес ядра без «/» в конце (https://your-core.example.com). */
  baseUrl: (c: Context) => string;
  now?: () => number;
}

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;
/** Сколько живёт страница с вызовом пасскея. */
const CEREMONY_TTL = 10 * 60;
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
    if (!client) return { error: 'Unknown client. Remove the connector and add it again.' };
    if (!client.r.includes(params.redirect_uri)) return { error: 'This redirect URI is not registered for the client.' };
    if (source.response_type !== undefined && source.response_type !== 'code') return { error: 'Only response_type=code is supported.' };
    if (params.code_challenge_method !== 'S256' || !params.code_challenge) return { error: 'PKCE with S256 is required.' };
    return { params, client };
  };

  /** Код входа клиенту: адрес возврата с `code`, `state` и `iss`. */
  const codeRedirect = (c: Context, params: Record<string, string>) => {
    const code = signer.sign('code', { jti: randomUUID(), c: sha256(params.client_id!), r: params.redirect_uri, ch: params.code_challenge }, CODE_TTL);
    const redirect = new URL(params.redirect_uri!);
    redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    redirect.searchParams.set('iss', baseUrl(c));
    return redirect.toString();
  };

  const expected = (c: Context, challenge: string): Expected => {
    const origin = baseUrl(c);
    return { challenge, origin, rpId: new URL(origin).hostname };
  };

  /** Формы и вызовы пасскея уходят только со своей страницы: чужой сайт не отправит их сюда от имени владельца. */
  const foreign = (c: Context, required: boolean) => {
    const origin = c.req.header('origin');
    return required ? origin !== baseUrl(c) : Boolean(origin && origin !== 'null' && origin !== baseUrl(c));
  };

  /** Вызов пасскея подписан вместе с параметрами OAuth (`p`), поэтому их нельзя подменить между страницей и ответом. */
  const ceremony = (op: 'create' | 'get', params: Record<string, string> | null) => {
    const challenge = randomBytes(32).toString('base64url');
    return { challenge, ticket: signer.sign('passkey', { jti: randomUUID(), op, ch: challenge, p: params }, CEREMONY_TTL) };
  };

  const createView = (c: Context, params: Record<string, string> | null) => {
    const { challenge, ticket } = ceremony('create', params);
    return createPage({ ticket, endpoint: '/passkey/register', options: {
      challenge, rp: { name: 'Helm', id: expected(c, challenge).rpId }, user: { id: Buffer.from('helm-owner').toString('base64url'), name: 'Helm owner', displayName: 'Helm owner' },
      pubKeyCredParams: PUBLIC_KEY_ALGORITHMS.map(alg => ({ type: 'public-key', alg })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, attestation: 'none', timeout: CEREMONY_TTL * 1000
    } });
  };

  /** Пароль: проверка с паузой после 10 неверных за 15 минут на всё ядро; null — принят. */
  const checkPassword = (value: string | undefined): { status: 401 | 429; text: string } | null => {
    if (tooManyFailures()) return { status: 429, text: 'Too many wrong passwords. Wait 15 minutes.' };
    if (safeEqual(value ?? '', password)) return null;
    failures.count += 1;
    return { status: 401, text: 'Wrong password.' };
  };
  const passwordOff = (c: Context) => c.html(messagePage('Password sign-in is off', 'This Helm signs in with a passkey. Open the page again from your client.'), 403);

  app.get('/authorize', async c => {
    const parsed = authorizeParams(c.req.query());
    if (parsed.error !== undefined) return c.text(parsed.error, 400);
    const passkeys = await options.passkeys.list();
    if (!passkeys.length) return c.html(passwordPage('/authorize', parsed.params, parsed.client.n));
    const { challenge, ticket } = ceremony('get', parsed.params);
    return c.html(loginPage(parsed.client.n, { ticket, endpoint: '/authorize/passkey', options: {
      challenge, rpId: expected(c, challenge).rpId, userVerification: 'required', timeout: CEREMONY_TTL * 1000,
      allowCredentials: passkeys.map(p => ({ type: 'public-key', id: p.id }))
    } }));
  });

  app.post('/authorize', async c => {
    if (foreign(c, false)) return c.text('Form from another site.', 403);
    const source = await fields(c);
    const parsed = authorizeParams(source);
    if (parsed.error !== undefined) return c.text(parsed.error, 400);
    if ((await options.passkeys.list()).length) return passwordOff(c);
    const wrong = checkPassword(source.password);
    if (wrong) return c.html(passwordPage('/authorize', parsed.params, parsed.client.n, wrong.text), wrong.status);
    return c.html(createView(c, parsed.params));
  });

  app.get('/passkey', async c => c.html((await options.passkeys.list()).length ? readyPage() : passwordPage('/passkey', {}, null)));

  app.post('/passkey', async c => {
    if (foreign(c, false)) return c.text('Form from another site.', 403);
    if ((await options.passkeys.list()).length) return passwordOff(c);
    const wrong = checkPassword((await fields(c)).password);
    if (wrong) return c.html(passwordPage('/passkey', {}, null, wrong.text), wrong.status);
    return c.html(createView(c, null));
  });

  /** Тело вызова пасскея и его билет; билет одноразовый. */
  const ceremonyBody = async (c: Context, op: 'create' | 'get') => {
    if (foreign(c, true)) return { error: 'Request from another site.' };
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return { error: 'Bad request.' }; }
    const ticket = signer.verify('passkey', body?.ticket);
    if (!ticket || ticket.op !== op) return { error: 'This page expired. Reload it and try again.' };
    if (!signer.consumeOnce(`passkey:${ticket.jti}`, ticket.exp)) return { error: 'This page was already used. Reload it.' };
    const params = ticket.p ? authorizeParams(ticket.p as Fields) : null;
    if (params?.error !== undefined) return { error: params.error };
    return { body, challenge: String(ticket.ch), params: params?.params ?? null };
  };

  app.post('/passkey/register', async c => {
    const got = await ceremonyBody(c, 'create');
    if (got.error !== undefined) return c.json({ error: got.error }, 400);
    const passkey = verifyRegistration(got.body, expected(c, got.challenge), new Date(now()));
    if (typeof passkey === 'string') return c.json({ error: passkey }, 400);
    if (!(await options.passkeys.add(passkey))) return c.json({ error: 'A passkey is already set up. Reload the page.' }, 409);
    return c.json({ redirect: got.params ? codeRedirect(c, got.params) : '/passkey' });
  });

  app.post('/authorize/passkey', async c => {
    const got = await ceremonyBody(c, 'get');
    if (got.error !== undefined) return c.json({ error: got.error }, 400);
    if (!got.params) return c.json({ error: 'Bad request.' }, 400);
    const passkey = (await options.passkeys.list()).find(p => p.id === got.body.id);
    if (!passkey) return c.json({ error: 'This passkey is not set up for Helm.' }, 401);
    const result = verifyAssertion(got.body, passkey, expected(c, got.challenge));
    if (typeof result === 'string') return c.json({ error: result }, 401);
    await options.passkeys.setCounter(passkey.id, result.counter);
    return c.json({ redirect: codeRedirect(c, got.params) });
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
