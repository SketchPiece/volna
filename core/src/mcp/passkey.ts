import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Пасскей владельца для входа в Helm MCP (docs/helm-mcp.md, 3). Пароль нужен один раз: пока пасскея нет, он пускает
 * к созданию пасскея; когда пасскей есть, сервер пароль не принимает. Проверка WebAuthn своя, без библиотеки:
 * аттестацию не проверяем (`attestation: 'none'`), открытый ключ берём из `getPublicKey()` браузера (SPKI), а вход
 * проверяем подписью над authenticatorData и хешем clientDataJSON.
 */
export interface StoredPasskey {
  id: string;
  /** SPKI DER в base64url. */
  publicKey: string;
  algorithm: number;
  counter: number;
  createdAt: string;
}

/** COSE: ES256 (ключи Apple, Google, Windows), EdDSA, RS256. */
const ALGORITHMS: Record<number, string | null> = { [-7]: 'sha256', [-8]: null, [-257]: 'sha256' };
export const PUBLIC_KEY_ALGORITHMS = Object.keys(ALGORITHMS).map(Number);

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/** Пасскеи в файле на томе (`MEMORY_DIR/helm-mcp-passkey.json`); без файла — в памяти, для тестов. Сброс — удалить файл. */
export class PasskeyStore {
  readonly #file: string | undefined;
  #memory: StoredPasskey[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file?: string) {
    this.#file = file;
  }

  /** Испорченный файл — ошибка, а не пустой список: иначе вход снова пустил бы по паролю. */
  async list(): Promise<StoredPasskey[]> {
    if (!this.#file) return this.#memory;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
      if (!Array.isArray(parsed?.passkeys)) throw new Error(`${this.#file}: no passkeys list`);
      return parsed.passkeys;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Первый пасскей владельца; false, если он уже есть (две вкладки создали одновременно). */
  add(passkey: StoredPasskey): Promise<boolean> {
    return this.#serial(async () => {
      if ((await this.list()).length > 0) return false;
      await this.#save([passkey]);
      return true;
    });
  }

  setCounter(id: string, counter: number): Promise<void> {
    return this.#serial(async () => {
      const passkeys = await this.list();
      const passkey = passkeys.find(p => p.id === id);
      if (!passkey || passkey.counter === counter) return;
      passkey.counter = counter;
      await this.#save(passkeys);
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #save(passkeys: StoredPasskey[]): Promise<void> {
    if (!this.#file) { this.#memory = passkeys; return; }
    await mkdir(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ passkeys }, null, 2), { mode: 0o600 });
    await rename(temp, this.#file);
  }
}

export interface Expected {
  challenge: string;
  /** Адрес страницы входа (`https://host`), с которой браузер вызывал WebAuthn. */
  origin: string;
  rpId: string;
}

export interface RegistrationInput { id?: unknown; clientDataJSON?: unknown; authenticatorData?: unknown; publicKey?: unknown; algorithm?: unknown }
export interface AssertionInput { id?: unknown; clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown }

const bytes = (value: unknown): Buffer | null => typeof value === 'string' && value.length > 0 && value.length < 16_384 && /^[A-Za-z0-9_-]+$/.test(value) ? Buffer.from(value, 'base64url') : null;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest();

function checkClientData(raw: Buffer, type: string, expected: Expected): string | null {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(raw.toString('utf8')); } catch { return 'Bad client data.'; }
  if (data.type !== type) return 'Wrong ceremony.';
  if (data.challenge !== expected.challenge) return 'Wrong challenge.';
  if (data.origin !== expected.origin || data.crossOrigin === true) return 'Wrong origin.';
  return null;
}

function checkAuthenticatorData(data: Buffer, rpId: string): { counter: number } | string {
  if (data.length < 37) return 'Bad authenticator data.';
  if (!data.subarray(0, 32).equals(sha(rpId))) return 'Wrong relying party.';
  const flags = data[32]!;
  if (!(flags & FLAG_USER_PRESENT) || !(flags & FLAG_USER_VERIFIED)) return 'The passkey did not verify you.';
  return { counter: data.readUInt32BE(33) };
}

export function verifyRegistration(input: RegistrationInput, expected: Expected, now: Date): StoredPasskey | string {
  const clientData = bytes(input.clientDataJSON);
  const authenticatorData = bytes(input.authenticatorData);
  const publicKey = bytes(input.publicKey);
  const id = bytes(input.id);
  const algorithm = Number(input.algorithm);
  if (!clientData || !authenticatorData || !publicKey || !id || !(algorithm in ALGORITHMS)) return 'Incomplete passkey.';
  const clientError = checkClientData(clientData, 'webauthn.create', expected);
  if (clientError) return clientError;
  const authenticator = checkAuthenticatorData(authenticatorData, expected.rpId);
  if (typeof authenticator === 'string') return authenticator;
  try { createPublicKey({ key: publicKey, format: 'der', type: 'spki' }); } catch { return 'Unreadable public key.'; }
  return { id: input.id as string, publicKey: input.publicKey as string, algorithm, counter: authenticator.counter, createdAt: now.toISOString() };
}

/** Новый счётчик подписей или текст ошибки. */
export function verifyAssertion(input: AssertionInput, passkey: StoredPasskey, expected: Expected): { counter: number } | string {
  const clientData = bytes(input.clientDataJSON);
  const authenticatorData = bytes(input.authenticatorData);
  const signature = bytes(input.signature);
  if (!clientData || !authenticatorData || !signature || input.id !== passkey.id) return 'Incomplete passkey answer.';
  const clientError = checkClientData(clientData, 'webauthn.get', expected);
  if (clientError) return clientError;
  const authenticator = checkAuthenticatorData(authenticatorData, expected.rpId);
  if (typeof authenticator === 'string') return authenticator;
  let key: KeyObject;
  try { key = createPublicKey({ key: Buffer.from(passkey.publicKey, 'base64url'), format: 'der', type: 'spki' }); } catch { return 'Unreadable public key.'; }
  const signed = Buffer.concat([authenticatorData, sha(clientData)]);
  let valid = false;
  try { valid = verify(ALGORITHMS[passkey.algorithm] ?? null, signed, key, signature); } catch { valid = false; }
  if (!valid) return 'Wrong signature.';
  // Синхронизируемые пасскеи (iCloud, Google) держат счётчик 0; растущий счётчик не должен идти назад: иначе это копия ключа.
  if ((authenticator.counter > 0 || passkey.counter > 0) && authenticator.counter <= passkey.counter) return 'Passkey counter went back.';
  return { counter: authenticator.counter };
}
