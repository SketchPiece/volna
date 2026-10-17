import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEND_TOKENS, estimateTokens, fitAppend } from './append-limit.ts';
import { LiveCalls } from './live-calls.ts';

test('appends to a live call never exceed the 500-token limit; short ones pass untouched', () => {
  assert.equal(fitAppend('Готово.'), 'Готово.');
  const long = 'Тариф А дешевле на двести рублей и даёт больше гигабайт. '.repeat(60);
  const fitted = fitAppend(long);
  assert.ok(estimateTokens(fitted) <= APPEND_TOKENS);
  assert.ok(fitted.endsWith('.…'), 'cut at the end of a sentence');
  const sent: any[] = [];
  const calls = new LiveCalls();
  calls.listener().attach!({ send: (event: any) => sent.push(event) } as any);
  calls.announce(long);
  assert.ok(estimateTokens(sent[0].content) <= APPEND_TOKENS);
});
