import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNOUNCE_NUDGE, ANNOUNCE_NUDGE_URGENT, LiveCalls } from './live-calls.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function call(calls: LiveCalls) {
  const sent: string[] = [];
  const listener = calls.listener();
  listener.attach!({ send: (event: any) => { sent.push(event.content); } } as any);
  return { sent, listener };
}

test('a note Volna stays silent after is asked for once more; not while the user talks, not if she spoke', async () => {
  const calls = new LiveCalls({ nudgeMs: 30, quietMs: 30, maxWaitMs: 500 });
  const silent = call(calls);
  calls.announce('Ядро: задание готово.');
  await wait(60);
  assert.deepEqual(silent.sent, ['Ядро: задание готово.', ANNOUNCE_NUDGE], 'silence after the note: one short nudge');
  await wait(60);
  assert.equal(silent.sent.length, 2, 'only once');
  silent.listener.close!();

  const spoke = call(calls);
  calls.announce('Ядро: задание готово.');
  spoke.listener.observe!({ type: 'session.output_transcript.delta', delta: 'Готово' });
  await wait(60);
  assert.equal(spoke.sent.length, 1, 'Volna said it: no nudge');
  spoke.listener.close!();

  const talking = call(calls);
  calls.announce('Ядро: задание готово.');
  const speech = setInterval(() => talking.listener.observe!({ type: 'session.input_transcript.delta', delta: 'а' }), 10);
  await wait(80);
  assert.equal(talking.sent.length, 1, 'the user is talking: wait for a pause');
  clearInterval(speech);
  await wait(80);
  assert.deepEqual(talking.sent.at(-1), ANNOUNCE_NUDGE, 'after the pause the nudge goes');
  talking.listener.close!();
});

test('an urgent note (a finished task) is asked for again without waiting for a pause', async () => {
  const calls = new LiveCalls({ nudgeMs: 30, quietMs: 30, maxWaitMs: 500 });
  const talking = call(calls);
  calls.announce('Ядро: задание готово.', { urgent: true });
  const speech = setInterval(() => talking.listener.observe!({ type: 'session.input_transcript.delta', delta: 'а' }), 10);
  await wait(60);
  clearInterval(speech);
  assert.deepEqual(talking.sent, ['Ядро: задание готово.', ANNOUNCE_NUDGE_URGENT], 'the user is still talking, the nudge goes anyway');
  talking.listener.close!();
});
