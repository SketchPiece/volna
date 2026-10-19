import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasskeyStore, type StoredPasskey } from './passkey.ts';

const passkey = (id: string): StoredPasskey => ({ id, publicKey: 'AAAA', algorithm: -7, counter: 0, createdAt: '2026-10-19T00:00:00.000Z' });

test('the passkey file keeps one owner passkey and survives a restart', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'passkey-')), 'helm-mcp-passkey.json');
  const store = new PasskeyStore(file);
  assert.deepEqual(await store.list(), []);
  const [first, second] = await Promise.all([store.add(passkey('a')), store.add(passkey('b'))]);
  assert.deepEqual([first, second], [true, false]);
  await store.setCounter('a', 7);
  assert.deepEqual((await new PasskeyStore(file).list()).map(p => [p.id, p.counter]), [['a', 7]]);
  assert.match(await readFile(file, 'utf8'), /"passkeys"/);
});

test('a broken passkey file is an error, not an empty list that would let the password back in', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'passkey-')), 'helm-mcp-passkey.json');
  await writeFile(file, '{oops');
  await assert.rejects(new PasskeyStore(file).list());
  await writeFile(file, '{}');
  await assert.rejects(new PasskeyStore(file).list());
});
