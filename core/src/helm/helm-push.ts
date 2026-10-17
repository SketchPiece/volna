import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { APNS_HOSTS, ApnsProviderToken, http2Transport, type ApnsTransport } from '../push/apns.ts';
import type { PushEnvironment } from '../push/devices.ts';
import {
  alertAllowed, alertForRows, changedRows, isTerminal, makeAggregate, MINUTE, rowForState, rowKey, stateSchema,
  type Aggregate, type Alert, type AgentState, type Preferences
} from './aggregate.ts';

/**
 * Уведомления и Live Activity мобильного «Штурвала» (docs/helm-push.md). Сервер «Штурвала» на Mac присылает
 * состояние тредов, телефон регистрирует токены; ядро держит карточку и шлёт пуши через APNs тем же ключом
 * команды, что и Волна. Карточку Live Activity запускает само приложение; ядро её обновляет и закрывает.
 */

const tokenSchema = z.string().regex(/^[0-9a-fA-F]{32,400}$/);
export const preferencesSchema = z.object({
  liveActivitiesEnabled: z.boolean(),
  notificationsEnabled: z.boolean(),
  notifyOnApproval: z.boolean(),
  notifyOnInput: z.boolean(),
  notifyOnCompletion: z.boolean(),
  notifyOnFailure: z.boolean()
});

/** Тело регистрации телефона: то же, что принимает релей T3 Connect. */
export const deviceRegistrationSchema = z.object({
  deviceId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  platform: z.enum(['ios', 'android']),
  iosMajorVersion: z.number().int().optional(),
  androidApiLevel: z.number().int().optional(),
  appVersion: z.string().optional(),
  bundleId: z.string().regex(/^[A-Za-z0-9.-]{3,200}$/).optional(),
  apsEnvironment: z.enum(['sandbox', 'production']).optional(),
  pushToken: tokenSchema.optional(),
  pushToStartToken: tokenSchema.optional(),
  preferences: preferencesSchema
});
export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;

const aggregateSchema = z.custom<Aggregate>(value => typeof value === 'object' && value !== null);
const deviceSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  bundleId: z.string(),
  environment: z.enum(['development', 'production']),
  pushToken: tokenSchema.nullable(),
  activityToken: tokenSchema.nullable(),
  preferences: preferencesSchema,
  /** Когда приложение запустило карточку: первые две минуты пустая карточка не закрывается. */
  armedAt: z.number().nullable(),
  lastAggregate: aggregateSchema.nullable(),
  lastDeliveryAt: z.number().nullable(),
  /** Тред → фаза, о которой уже было уведомление: одно уведомление на переход. */
  alerted: z.record(z.string(), z.string())
});
type Device = z.infer<typeof deviceSchema>;

const fileSchema = z.object({
  states: z.array(stateSchema).default([]),
  devices: z.array(deviceSchema).default([])
});

/** Обновления карточки без перехода не чаще раза в 15 секунд: у Apple бюджет на частые пуши. */
const UPDATE_INTERVAL_MS = 15_000;
const ARMED_GRACE_MS = 2 * MINUTE;
const STALE_AFTER_S = 600;

export interface HelmPushOptions {
  dir: string;
  apns: { keyPem: string; keyId: string; teamId: string } | null;
  log: Logger;
  transport?: ApnsTransport;
  now?: () => Date;
}

export class HelmPush {
  readonly #options: HelmPushOptions;
  readonly #provider: ApnsProviderToken | null;
  readonly #states = new Map<string, AgentState>();
  readonly #devices = new Map<string, Device>();
  #loaded = false;
  /** Публикации и регистрации идут по одной: карточка всегда считается от последнего состояния. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: HelmPushOptions) {
    this.#options = options;
    this.#provider = options.apns ? new ApnsProviderToken({ ...options.apns, now: options.now }) : null;
  }

  get canPush(): boolean { return this.#provider !== null; }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const file = fileSchema.parse(JSON.parse(await readFile(join(this.#options.dir, 'helm.json'), 'utf8')));
      for (const state of file.states) this.#states.set(rowKey(state), state);
      for (const device of file.devices) this.#devices.set(device.deviceId, device);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#options.log.warn('helm state unreadable', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  /** Состояние треда от сервера «Штурвала»; null — тред больше не показываем. */
  publish(key: { environmentId: string; threadId: string }, state: AgentState | null): Promise<void> {
    return this.#serial(async () => {
      const id = rowKey(key);
      if (state) this.#states.set(id, state); else this.#states.delete(id);
      this.#prune();
      const aggregate = makeAggregate([...this.#states.values()], state && isTerminal(state.phase) ? state : null, this.#nowMs());
      for (const device of this.#devices.values()) await this.#deliver(device, aggregate, state, false);
      await this.#persist();
    });
  }

  registerDevice(input: DeviceRegistration): Promise<void> {
    return this.#serial(async () => {
      if (input.platform !== 'ios' || !input.bundleId) return;
      const existing = this.#devices.get(input.deviceId);
      const environment: PushEnvironment = input.apsEnvironment === 'sandbox' ? 'development' : 'production';
      // Токен переехал на другое устройство (переустановка): у старой записи его забираем.
      for (const other of this.#devices.values()) if (other.deviceId !== input.deviceId && other.pushToken === input.pushToken) other.pushToken = null;
      const device: Device = {
        deviceId: input.deviceId,
        label: input.label,
        bundleId: input.bundleId,
        // Подтверждённое APNs окружение не перебиваем: сборка из Xcode зовёт себя production, а токены у неё sandbox.
        environment: existing?.bundleId === input.bundleId ? existing.environment : environment,
        pushToken: input.pushToken ?? existing?.pushToken ?? null,
        activityToken: existing?.activityToken ?? null,
        preferences: input.preferences,
        armedAt: existing?.armedAt ?? null,
        lastAggregate: existing?.lastAggregate ?? null,
        lastDeliveryAt: existing?.lastDeliveryAt ?? null,
        alerted: existing?.alerted ?? {}
      };
      this.#devices.set(device.deviceId, device);
      await this.#replay(device);
      await this.#persist();
    });
  }

  unregisterDevice(deviceId: string): Promise<void> {
    return this.#serial(async () => {
      this.#devices.delete(deviceId);
      await this.#persist();
    });
  }

  /** Приложение запустило карточку и прислало её токен: сразу показываем текущее состояние, без звука. */
  registerLiveActivity(input: { deviceId: string; activityPushToken: string }): Promise<boolean> {
    return this.#serial(async () => {
      const device = this.#devices.get(input.deviceId);
      if (!device) return false;
      for (const other of this.#devices.values()) if (other.activityToken === input.activityPushToken) other.activityToken = null;
      Object.assign(device, { activityToken: input.activityPushToken, armedAt: this.#nowMs(), lastAggregate: null, lastDeliveryAt: null });
      await this.#replay(device);
      await this.#persist();
      return true;
    });
  }

  snapshot(): Aggregate | null {
    return makeAggregate([...this.#states.values()], null, this.#nowMs());
  }

  #replay(device: Device): Promise<void> {
    return this.#deliver(device, this.snapshot(), null, true);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => this.load()).then(work);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  #nowMs(): number { return (this.#options.now ?? (() => new Date()))().getTime(); }

  /** Закончившиеся треды старше суток уходят из памяти. */
  #prune(): void {
    const nowMs = this.#nowMs();
    for (const [key, state] of this.#states) {
      if (isTerminal(state.phase) && nowMs - (Date.parse(state.updatedAt) || 0) > 24 * 60 * MINUTE) this.#states.delete(key);
    }
  }

  async #deliver(device: Device, aggregate: Aggregate | null, published: AgentState | null, replay: boolean): Promise<void> {
    if (!this.#provider) return;
    const nowMs = this.#nowMs();
    if (device.activityToken && !device.preferences.liveActivitiesEnabled) {
      // Карточки выключены в настройках: закрываем, дальше — обычные уведомления.
      await this.#liveActivity(device, 'end', null, null);
      Object.assign(device, { activityToken: null, lastAggregate: null });
    }
    if (device.activityToken) {
      if (!aggregate) {
        // Только что запущенную карточку не закрываем: работа ещё не успела дойти до ядра.
        if (device.armedAt !== null && nowMs - device.armedAt < ARMED_GRACE_MS) return;
        if (await this.#liveActivity(device, 'end', null, null)) Object.assign(device, { activityToken: null, lastAggregate: null });
        return;
      }
      const previous = device.lastAggregate;
      if (previous && JSON.stringify(previous) === JSON.stringify(aggregate)) return;
      const changed = changedRows(previous, aggregate);
      const due = !previous || previous.activeCount !== aggregate.activeCount || changed.waiting.length > 0 || changed.finished.length > 0
        || device.lastDeliveryAt === null || nowMs - device.lastDeliveryAt >= UPDATE_INTERVAL_MS;
      if (!due) return;
      const alert = replay ? null : this.#alertFor(device, [...changed.waiting, ...changed.finished], nowMs);
      if (await this.#liveActivity(device, 'update', aggregate, alert)) Object.assign(device, { lastAggregate: aggregate, lastDeliveryAt: nowMs });
      return;
    }
    // Без карточки — обычное уведомление о треде, который сейчас ждёт владельца или закончился.
    if (replay || !published || !device.pushToken) return;
    const alert = this.#alertFor(device, [rowForState(published)], nowMs);
    if (alert) await this.#notify(device, alert, published);
  }

  /** Уведомление о переходах, о которых телефон ещё не слышал, с учётом его настроек. */
  #alertFor(device: Device, rows: ReturnType<typeof rowForState>[], nowMs: number): Alert | null {
    const fresh = rows.filter(row => alertAllowed(device.preferences, row, nowMs) && device.alerted[rowKey(row)] !== row.phase);
    for (const row of fresh) device.alerted[rowKey(row)] = row.phase;
    for (const key of Object.keys(device.alerted)) if (!this.#states.has(key)) delete device.alerted[key];
    return alertForRows(fresh);
  }

  #liveActivity(device: Device, event: 'update' | 'end', aggregate: Aggregate | null, alert: Alert | null): Promise<boolean> {
    const timestamp = Math.floor(this.#nowMs() / 1000);
    const contentState = aggregate ? { 'content-state': { name: 'AgentActivity', props: JSON.stringify(aggregate) } } : {};
    const aps = event === 'update'
      ? { timestamp, event, ...contentState, 'stale-date': timestamp + STALE_AFTER_S, ...(alert ? { alert: { ...alert, sound: 'default' } } : {}) }
      : { timestamp, event, 'dismissal-date': timestamp + 15 };
    return this.#send(device, 'activityToken', {
      'apns-push-type': 'liveactivity', 'apns-topic': `${device.bundleId}.push-type.liveactivity`, 'apns-priority': alert || event === 'end' ? '10' : '5'
    }, { aps });
  }

  #notify(device: Device, alert: Alert, state: AgentState): Promise<boolean> {
    return this.#send(device, 'pushToken', { 'apns-push-type': 'alert', 'apns-topic': device.bundleId, 'apns-priority': '10' }, {
      aps: { alert, sound: 'default', 'thread-id': rowKey(state) },
      environmentId: state.environmentId, threadId: state.threadId, deepLink: rowForState(state).deepLink
    });
  }

  /**
   * Один пуш. BadDeviceToken часто значит не то окружение APNs (сборка из Xcode с sandbox-токенами зовёт себя
   * production): пробуем второе и запоминаем, какое ответило. Мёртвый токен забываем.
   */
  async #send(device: Device, kind: 'pushToken' | 'activityToken', headers: Record<string, string>, body: object): Promise<boolean> {
    const token = device[kind];
    if (!token || !this.#provider) return false;
    const { transport = http2Transport, log } = this.#options;
    const attempt = (environment: PushEnvironment) => transport({
      host: APNS_HOSTS[environment], path: `/3/device/${token}`,
      headers: { authorization: `bearer ${this.#provider!.value()}`, ...headers }, body: JSON.stringify(body)
    });
    try {
      let response = await attempt(device.environment);
      if (response.status === 400 && response.reason === 'BadDeviceToken') {
        const other: PushEnvironment = device.environment === 'production' ? 'development' : 'production';
        const retry = await attempt(other);
        if (retry.status === 200) device.environment = other;
        response = retry;
      }
      if (response.status === 200) { log.info('helm push sent', { kind: headers['apns-push-type'] }); return true; }
      log.warn('helm push rejected', { kind: headers['apns-push-type'], status: response.status, reason: response.reason });
      if (response.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(response.reason ?? '')) device[kind] = null;
      return false;
    } catch (error) {
      log.warn('helm push failed', { error: error instanceof Error ? error.name : 'unknown' });
      return false;
    }
  }

  async #persist(): Promise<void> {
    await mkdir(this.#options.dir, { recursive: true });
    const target = join(this.#options.dir, 'helm.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ states: [...this.#states.values()], devices: [...this.#devices.values()] }, null, 2));
    await rename(temp, target);
  }
}
