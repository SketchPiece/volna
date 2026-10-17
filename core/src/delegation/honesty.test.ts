import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsAction, claimsByWords, confirmsAction, honestyFallback, HONESTY_FALLBACK, unrecovered, type CallNote } from './honesty.ts';

test('claims of done or promised actions are recognised; refusals, negations and plain answers are not', () => {
  for (const text of ['Понял. Ставлю. Напомню завтра в десять купить молоко.', 'Записал: купить хлеб.', 'Готово, встреча назначена. Назначил на пятницу.',
    'Отправил Пете сообщение.', 'Я поставила напоминание.', 'Запомню, что вы не пьёте кофе.', 'Добавил в календарь.',
    'хм, секунду. Считаю на маке.', 'Открою калькулятор на Маке и посчитаю.', 'Запустил задачу.']) {
    assert.equal(claimsAction(text), true, text);
  }
  for (const text of ['Сейчас десять часов утра.', 'Не могу поставить напоминание: доступа нет.', 'Я не поставил напоминание, инструмента нет.',
    'Напоминаний, календаря и контактов сейчас нет.', 'Семью восемь — пятьдесят шесть.', 'Завтра в Берлине солнечно, до двадцати градусов.', 'Хотите, чтобы я записал?',
    'Я считаю, лучше взять второй.']) {
    assert.equal(claimsAction(text), false, text);
  }
});

test('only a successful changing tool confirms an action', () => {
  assert.equal(confirmsAction('write', '{"id":"r1"}'), true);
  assert.equal(confirmsAction('write', '{"error":"device_unavailable"}'), false);
  assert.equal(confirmsAction('read', '{"iso":"x"}'), false);
  assert.equal(confirmsAction('act', '{"saved":["x"]}'), true);
  assert.equal(confirmsAction(undefined, '{"ok":true}'), false, 'an unknown tool confirms nothing');
});

// Аудит 26.09.2026: краткие причастия и начало дела предфильтр не видел, и Jev их не проверял.
test('participles and «starting now» claims are recognised; negated participles, questions and honest answers are not', () => {
  for (const text of ['Напоминание создано на завтра.', 'Записано.', 'Напоминание поставлено.', 'Добавлено в календарь.', 'Отправлено Клоду.',
    'Передал Клоду.', 'Запускаю работу.', 'Уже ищу на маке.', 'Займусь, разберусь на маке.', 'Перезвоню, как будет готово.', 'Встреча перенесена на пятницу.',
    'Сейчас наберу.', 'Наберу через пять минут.', 'Звоню через пять минут.']) {
    assert.equal(claimsAction(text), true, text);
  }
  for (const text of ['Что Вы ищете?', 'Напоминание не создано: доступа нет.', 'Не могу поставить напоминание.', 'Работа ещё не запущена.',
    'Ничего не было отправлено.', 'Хотите, чтобы я передал Клоду?', 'Запустить работу на маке?', 'Завтра в девять у Вас встреча с врачом.',
    'Это умеет агент на маке: разбирать файлы и искать в интернете.', 'Набрать Вас через пять минут?', 'Не наберу: звонить мне нечем.']) {
    assert.equal(claimsAction(text), false, text);
  }
});

const ok = (tool: string, effect = 'write'): CallNote => ({ tool, effect, ok: true });
const failed = (tool: string, effect = 'write'): CallNote => ({ tool, effect, ok: false });

test('a failure counts as fixed only when later successes of the same tool cover every failure', () => {
  assert.deepEqual(unrecovered([failed('send', 'act'), ok('send', 'act')]), [], 'a retry after an error');
  // Два напоминания, оба упали, повтор удался у одного: одно так и не поставлено.
  assert.deepEqual(unrecovered([failed('create_reminder'), failed('create_reminder'), ok('create_reminder')]), [failed('create_reminder')]);
  assert.deepEqual(unrecovered([ok('create_reminder'), failed('create_reminder')]), [failed('create_reminder')], 'an earlier success fixes nothing');
  assert.deepEqual(unrecovered([failed('current_time', 'read')]), [], 'reading tools do not count');
});

test('without Jev the words decide: no calls, or only failed changing calls; never after reading calls alone', () => {
  assert.equal(claimsByWords([], false), true);
  assert.equal(claimsByWords([failed('send', 'act')], false), true, '«Отправил» after a failed send');
  assert.equal(claimsByWords([ok('about_wave', 'read')], false), false, '«Меня сделал Андрей» after about_wave');
  assert.equal(claimsByWords([ok('note'), failed('send', 'act')], true), false, 'a partial success is left to Jev');
});

test('the honest fallback names what worked in plain words, never tool names, and does not say a tool was not called', () => {
  assert.doesNotMatch(HONESTY_FALLBACK, /инструмент/);
  const partial = honestyFallback([ok('create_reminder'), failed('work_send', 'act'), ok('plugin_x_do', 'act')]);
  assert.match(partial, /получилось напоминание; остальное не получилось/);
  assert.doesNotMatch(partial, /create_reminder|work_send|plugin_x_do/);
  assert.match(partial, /названия инструментов не произноси/);
  assert.match(honestyFallback([ok('plugin_x_do', 'act'), failed('send', 'act')]), /^Бэкенд сделал только часть; остальное не получилось/);
});
