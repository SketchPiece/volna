import { connect } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { Logger } from '../log.ts';
import type { DeviceTokens, PushEnvironment } from './devices.ts';

/**
 * Пуши на iPhone через APNs (HTTP/2, токен-аутентификация ES256 ключом .p8 из Apple Developer).
 * VoIP-пуш будит приложение и показывает входящий звонок Волны (PushKit + CallKit); обычный пуш — уведомление.
 * Токены устройства присылает приложение (`POST /push/register`); окружение (sandbox или боевое) приходит вместе с ними.
 * Содержимое пушей в лог не пишется.
 */
export interface PushSender {
  /** Есть ключ и хотя бы один токен нужного вида. */
  canCall(): boolean;
  canNotify(): boolean;
  /** Входящий звонок Волны: приложение обязано сразу показать его через CallKit. */
  call(payload: Record<string, unknown>): Promise<boolean>;
  notify(alert: { title: string; body: string }, data?: Record<string, unknown>): Promise<boolean>;
}

export interface ApnsRequest { host: string; path: string; headers: Record<string, string>; body: string }
export interface ApnsResponse { status: number; reason: string | null }
export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>;

export interface ApnsOptions {
  /** Содержимое .p8 (PEM). */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** Bundle id приложения; для VoIP APNs ждёт `<bundle>.voip`. */
  topic: string;
  devices: DeviceTokens;
  log: Logger;
  transport?: ApnsTransport;
  now?: () => Date;
}

export const APNS_HOSTS: Readonly<Record<PushEnvironment, string>> = Object.freeze({
  development: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com'
});

/** JWT провайдера APNs: один ключ .p8 команды подписывает пуши всех её приложений (Волна, «Штурвал»). */
export class ApnsProviderToken {
  readonly #key: KeyObject;
  readonly #keyId: string;
  readonly #teamId: string;
  readonly #now: () => Date;
  #jwt: { value: string; issuedAt: number } | null = null;

  constructor(options: { keyPem: string; keyId: string; teamId: string; now?: () => Date }) {
    this.#key = createPrivateKey(options.keyPem);
    this.#keyId = options.keyId;
    this.#teamId = options.teamId;
    this.#now = options.now ?? (() => new Date());
  }

  /** APNs принимает токен до часа и не любит частую смену; обновляем раз в 50 минут. */
  value(): string {
    const now = Math.floor(this.#now().getTime() / 1000);
    if (this.#jwt && now - this.#jwt.issuedAt < 50 * 60) return this.#jwt.value;
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: this.#keyId })}.${encode({ iss: this.#teamId, iat: now })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: this.#key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.#jwt = { value: `${unsigned}.${signature}`, issuedAt: now };
    return this.#jwt.value;
  }
}

export class ApnsSender implements PushSender {
  readonly #options: ApnsOptions;
  readonly #provider: ApnsProviderToken;

  constructor(options: ApnsOptions) {
    this.#options = options;
    this.#provider = new ApnsProviderToken(options);
  }

  canCall(): boolean { return Boolean(this.#options.devices.current?.voip); }
  canNotify(): boolean { return Boolean(this.#options.devices.current?.alert); }

  call(payload: Record<string, unknown>): Promise<boolean> {
    // expiration 0: опоздавший звонок хуже никакого; дальше сработает запасное уведомление.
    return this.#send('voip', payload, { 'apns-push-type': 'voip', 'apns-priority': '10', 'apns-expiration': '0' });
  }

  notify(alert: { title: string; body: string }, data: Record<string, unknown> = {}): Promise<boolean> {
    return this.#send('alert', { aps: { alert, sound: 'default', 'interruption-level': 'time-sensitive' }, ...data }, { 'apns-push-type': 'alert', 'apns-priority': '10' });
  }

  async #send(kind: 'voip' | 'alert', body: Record<string, unknown>, headers: Record<string, string>): Promise<boolean> {
    const { devices, topic, log, transport = http2Transport } = this.#options;
    const device = devices.current;
    const token = device?.[kind];
    if (!device || !token) return false;
    try {
      const response = await transport({
        host: APNS_HOSTS[device.environment],
        path: `/3/device/${token}`,
        headers: { authorization: `bearer ${this.#provider.value()}`, 'apns-topic': kind === 'voip' ? `${topic}.voip` : topic, ...headers },
        body: JSON.stringify(body)
      });
      if (response.status === 200) { log.info('push sent', { kind }); return true; }
      log.warn('push rejected', { kind, status: response.status, reason: response.reason });
      // Токен больше не действует (приложение удалено или токен сменился): забываем, ждём новый.
      if (response.status === 410 || response.reason === 'BadDeviceToken' || response.reason === 'Unregistered') await devices.forget(kind);
      return false;
    } catch (error) {
      log.warn('push failed', { kind, error: error instanceof Error ? error.name : 'unknown' });
      return false;
    }
  }
}

/** Один запрос по HTTP/2; соединение не держим: пуши редкие. */
export const http2Transport: ApnsTransport = ({ host, path, headers, body }) => new Promise((resolve, reject) => {
  const session = connect(`https://${host}`);
  session.on('error', reject);
  const request = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json', ...headers });
  let status = 0;
  let text = '';
  request.setEncoding('utf8');
  request.setTimeout(10_000, () => request.close());
  request.on('response', response => { status = Number(response[':status'] ?? 0); });
  request.on('data', chunk => { text += chunk; });
  request.on('end', () => {
    session.close();
    let reason: string | null = null;
    try { reason = text ? JSON.parse(text).reason ?? null : null; } catch { /* пустое тело */ }
    resolve({ status, reason });
  });
  request.on('error', error => { session.close(); reject(error); });
  request.end(body);
});
