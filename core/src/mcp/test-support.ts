import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64 = (data: Buffer) => data.toString('base64url');
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest();

/** Данные страницы с пасскеем (`<script id="data">`): билет, адрес ответа и параметры WebAuthn. */
export function pageData(html: string): { mode: 'create' | 'get'; ticket: string; endpoint: string; options: any } | null {
  const match = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]!) : null;
}

/** Поддельный пасскей с ключом ES256: отвечает на create и get так, как браузер отдаёт их странице. */
export function fakeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = b64(randomBytes(16));
  let counter = 0;
  const authenticatorData = (rpId: string, flags: number) => {
    const data = Buffer.alloc(37);
    sha(rpId).copy(data);
    data[32] = flags;
    data.writeUInt32BE(counter, 33);
    return data;
  };
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    /** Растущий счётчик, как у аппаратных ключей; у пасскеев iCloud он 0. */
    tick() { counter += 1; },
    create(options: any, origin: string, patch: { rpId?: string; flags?: number } = {}) {
      return {
        id, clientDataJSON: b64(clientData('webauthn.create', options.challenge, origin)),
        authenticatorData: b64(authenticatorData(patch.rpId ?? options.rp.id, patch.flags ?? 0x05)),
        publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })), algorithm: -7
      };
    },
    get(options: any, origin: string, patch: { flags?: number; challenge?: string } = {}) {
      const data = authenticatorData(options.rpId, patch.flags ?? 0x05);
      const client = clientData('webauthn.get', patch.challenge ?? options.challenge, origin);
      return { id, clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(sign('sha256', Buffer.concat([data, sha(client)]), privateKey)) };
    }
  };
}
