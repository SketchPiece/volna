import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Окружение APNs: сборка из Xcode получает sandbox-токены, TestFlight и App Store — боевые. */
export type PushEnvironment = 'development' | 'production';

const tokenSchema = z.string().regex(/^[0-9a-f]{64,200}$/);
export const deviceSchema = z.object({
  /** PushKit-токен: входящий звонок Волны. */
  voip: tokenSchema.nullable().default(null),
  /** Токен уведомлений. */
  alert: tokenSchema.nullable().default(null),
  environment: z.enum(['development', 'production']),
  updatedAt: z.string().default('')
});
export type Device = z.infer<typeof deviceSchema>;

/**
 * Токены единственного телефона (`push.json`). Прототип для одного пользователя: новый телефон заменяет старый.
 * Сами токены не секрет, но пишутся только в файл, не в лог.
 */
export class DeviceTokens {
  readonly #dir: string;
  #device: Device | null = null;
  #loaded = false;

  constructor(dir: string) { this.#dir = dir; }

  get current(): Device | null { return this.#device; }

  async load(): Promise<Device | null> {
    if (this.#loaded) return this.#device;
    this.#loaded = true;
    try { this.#device = deviceSchema.parse(JSON.parse(await readFile(join(this.#dir, 'push.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof z.ZodError)) throw error; }
    return this.#device;
  }

  /** Новые токены; не присланный вид остаётся прежним, если окружение то же. */
  async register(input: { voip?: string | null; alert?: string | null; environment: PushEnvironment }, now: Date = new Date()): Promise<Device> {
    await this.load();
    const same = this.#device?.environment === input.environment ? this.#device : null;
    this.#device = deviceSchema.parse({
      voip: input.voip === undefined ? same?.voip ?? null : input.voip,
      alert: input.alert === undefined ? same?.alert ?? null : input.alert,
      environment: input.environment,
      updatedAt: now.toISOString()
    });
    await this.#persist();
    return this.#device;
  }

  async forget(kind: 'voip' | 'alert'): Promise<void> {
    if (!this.#device) return;
    this.#device = { ...this.#device, [kind]: null };
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, 'push.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.#device, null, 2));
    await rename(temp, target);
  }
}
