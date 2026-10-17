import test from 'node:test';
import assert from 'node:assert/strict';
import { CallTrace } from './trace.ts';
import { GreetingProbe, levelOf } from './greeting-probe.ts';

/** Кусок PCM16 постоянной амплитуды в base64. */
const pcm = (amplitude: number, samples = 480) => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return buffer.toString('base64');
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setup(silenceMs = 30) {
  let now = 0;
  const clock = () => now;
  const trace = new CallTrace({ callId: 'c', config: {}, clock });
  const probe = new GreetingProbe({ trace, silenceMs, clock });
  return { trace, probe, at: (ms: number) => { now = ms; }, marks: (type: string) => trace.events.filter(e => e.type === type) };
}

test('levels are measured in dB of full scale; silence is the floor', () => {
  assert.ok(Math.abs(levelOf(pcm(32767))!.peakDb) < 0.01);
  assert.equal(Math.round(levelOf(pcm(328))!.rmsDb), -40);
  assert.equal(levelOf(pcm(0))!.rmsDb, -100);
  assert.equal(levelOf(''), null);
});

test('a greeting that is said is marked with its delay; input level before the command is recorded', async () => {
  const { probe, at, marks } = setup();
  for (let t = 0; t < 1000; t += 200) { at(t); probe.observe({ type: 'session.input_audio.append', audio: pcm(328) }); }
  at(1000); probe.observe({ type: 'session.instructions.appended' });
  at(1800); probe.observe({ type: 'session.output_transcript.delta', delta: 'Да?' });
  await wait(50);
  const [trigger] = marks('greeting.trigger');
  assert.equal(trigger!.n, 1);
  assert.equal(Math.round(trigger!.inDb as number), -40);
  assert.equal(trigger!.chunks, 5);
  assert.deepEqual(marks('greeting.said').map(e => [e.n, e.ms, e.userSpoke]), [[1, 800, false]]);
  assert.equal(marks('greeting.silent').length, 0, 'no silence mark once Volna spoke');
});

test('silence after a command is marked with the input and output levels of the wait', async () => {
  const { probe, at, marks } = setup();
  at(1000); probe.observe({ type: 'session.instructions.appended' });
  at(1010); probe.observe({ type: 'session.input_audio.append', audio: pcm(0) });
  at(1020); probe.observe({ type: 'session.output_audio.delta', delta: pcm(0) });
  at(1040);
  await wait(60);
  const [silent] = marks('greeting.silent');
  assert.equal(silent!.n, 1);
  assert.equal(silent!.inDb, -100, 'the phone sent pure silence');
  assert.equal(silent!.outPeakDb, -100);
  assert.equal(marks('greeting.trigger')[0]!.chunks, 0, 'no input at all before the command');
  probe.close();
});

test('after the greeting window the probe stops listening', () => {
  const { probe, at, marks } = setup();
  at(31_000); probe.observe({ type: 'session.instructions.appended' });
  assert.equal(marks('greeting.trigger').length, 0);
});
