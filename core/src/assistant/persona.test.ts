import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstructions, buildBackendInstructions } from './persona.ts';
import { CALLBACK_GOODBYE_QUESTION, GOODBYE_QUESTION } from '../jev/questions.ts';

test('instructions describe available tools or their absence, persona stays intact', () => {
  const without = buildInstructions([]);
  assert.match(without, /Волна/);
  assert.match(without, /нет инструментов/);
  const withTools = buildInstructions(['current_time']);
  // Эксперимент 363cc0e (дневной голосовой промпт): имена инструментов снова в голосовых инструкциях.
  assert.match(withTools, /Инструменты бэкенда: current_time\./);
  assert.match(withTools, /выполняет бэкенд/);
  assert.match(withTools, /про бэкенд и делегирование не упоминай/);
  assert.match(withTools, /что ты умеешь/);
  assert.doesNotMatch(withTools, /нет инструментов/);
  assert.match(withTools, /Приветствие:/);
  assert.doesNotMatch(withTools, /Кибернетик/);
  assert.match(withTools, /возьми её у бэкенда \(about_wave\)/);
  assert.match(withTools, /Говоришь от мужского лица/);
  assert.match(withTools, /Сам её не рассказываешь/);
  assert.match(withTools, /на «Вы»/);
  assert.doesNotMatch(withTools, /Сейчас посмотрю/, 'a single verbatim filler example gets copied on every delegation');
  assert.match(withTools, /каждый раз другую/);
  // 26.09.2026 владелец: «секунду» раздражает, о себе Волна рассказывала неохотно, личную тему не развивала. Реплика
  // ожидания описана поведением и примерами, без списка запретных слов: список модель тоже повторяла.
  // В дневном промпте запретные слова названы прямо: «без „секунду“, „минутку“».
  assert.match(withTools, /подхвати слово из вопроса \(«Берлин… так»\) или назови действие/);
  assert.match(withTools, /без «секунду», «минутку», «гляну»/);
  // Вопросы: в делах только нужные, в разговоре о жизни расспрашивать можно.
  assert.match(withTools, /встречный вопрос только когда без него нельзя\. Когда разговор о жизни, а не о деле, тебе правда интересно/);
  assert.doesNotMatch(withTools, /столько, сколько спросили|не развивай тему/);
  assert.match(withTools, /рассказывай охотно/);
  assert.match(withTools, /любопытный/);
});

// 26.09.2026: разделы по гайду OpenAI «Prompting GPT-Live»: отклики, перебивание ≠ отмена, шумы, когда передавать бэкенду.
test('voice instructions follow the GPT-Live guide: backchannels, interruptions, noise, when to delegate and when not', () => {
  const voice = buildInstructions(['current_time']);
  assert.match(voice, /Отклики:/);
  assert.match(voice, /просьба замолчать, а не отменить дело/);
  assert.match(voice, /Кашель, музыку, телевизор/);
  assert.match(voice, /Передавай бэкенду:/);
  assert.match(voice, /Не передавай:/);
  assert.match(voice, /результат не угадывай/);
  assert.ok(voice.indexOf('Живой разговор') < voice.indexOf('Делегирование'), 'conversation rules come before delegation');
  assert.match(buildInstructions([]), /Перебивание:/, 'duplex rules hold without tools too');
  const waiting = buildInstructions(['current_time']);
  assert.match(waiting, /Эта реплика не обещает и не подтверждает результат/, 'the filler must not promise what the backend will confirm');
  assert.match(waiting, /то, что ты уже сказал, не повторяй/, 'the backend answer must not be said twice');
});

test('changing Volna herself (abilities, code, system, tech cards) is development, not character: the voice passes it on', () => {
  const voice = buildInstructions(['current_time']);
  assert.match(voice, /Это только о характере и манере речи: «можешь изменять себя\?», вопросы и просьбы о твоих возможностях, коде, системе, техкартах/);
  assert.match(voice, /Передавай бэкенду:[^\n]*о доработке тебя \(добавить или изменить возможность, код, систему, техкарту\)[^\n]*не говори, что не меняешься/);
  assert.match(buildInstructions([]), /о доработке Волны/, 'the distinction holds without tools too');
  for (const backend of [buildBackendInstructions([]), buildBackendInstructions(['work_start'])]) {
    assert.match(backend, /Доработка Волны: [^\n]*не о характере и манере речи[^\n]*не отвечай, что Волна не меняется/);
    assert.match(backend, /стать другим по характеру или говорить иначе \(смешнее, строже, короче, на «ты»\) — не доработка: работу не предлагай/);
  }
});

test('backend instructions carry the phone-tool rules without a separate tool list, or say there are none', () => {
  assert.match(buildBackendInstructions([]), /Инструментов нет/);
  const backend = buildBackendInstructions(['current_time', 'create_reminder']);
  assert.doesNotMatch(backend, /Инструменты: current_time/, 'the model sees tool names in their definitions');
  assert.match(backend, /ISO 8601/);
  assert.match(backend, /по-русски/);
});

test('a story about Volna herself is longer than a business answer, in both the voice and the backend rules', () => {
  // Дневной голосовой промпт (363cc0e) длину рассказа не называет: «охотно и с деталями».
  assert.match(buildInstructions(['about_wave']), /у бэкенда \(about_wave\) и рассказывай охотно, своими словами и с деталями/);
  assert.match(buildBackendInstructions([]), /рассказ о самой Волне по about_wave до пяти, с деталями/);
});

// 22.09.2026 «Ладно, всё, спасибо большое» не завершило звонок: ни Live, ни Jev не сочли это прощанием.
test('«всё» with thanks and no new request counts as a goodbye for Live, the backend and Jev', () => {
  assert.match(buildInstructions(['end_call']), /«ладно, всё, спасибо», «всё, спасибо большое» без новой просьбы тоже прощание/);
  assert.match(buildBackendInstructions(['end_call']), /«ладно, всё, спасибо», «всё, спасибо большое» без новой просьбы\), зови end_call/);
  assert.match(JSON.stringify(GOODBYE_QUESTION.criteria), /«ладно, всё, спасибо большое»/);
});

// Звонок 26.09.2026: «Ты можешь мне перезвонить, когда она закончится» — Волна записала перезвон и сказала «перезвоню»,
// но трубку не положила: без «пока» ни Jev (0.5), ни бэкенд не сочли это концом разговора.
test('a bare «call me back when it is done» ends the call for the backend and Jev', () => {
  assert.match(buildBackendInstructions(['end_call', 'tasks_call_back', 'work_start']), /tasks_call_back и, если он не добавил новой просьбы или вопроса, в том же ответе end_call/);
  assert.match(buildBackendInstructions(['end_call', 'tasks_call_back', 'work_start', 'work_answer']), /tasks_call_back и, если он не добавил новой просьбы или вопроса, в том же ответе end_call/);
  assert.match(buildBackendInstructions(['end_call']), /«перезвони, когда будет готово» без новой просьбы тоже конец разговора, даже без «пока»/);
  const criteria = CALLBACK_GOODBYE_QUESTION.criteria as { true: string; false: string };
  assert.match(criteria.true, /with or without a goodbye/);
  assert.match(criteria.true, /«ты можешь мне перезвонить, когда она закончится»/);
  assert.match(criteria.false, /«перезвони в шесть»/);
});

// Аудит 26.09.2026 чинил двойное прощание (реплика ожидания и пересказ прощания бэкенда); эксперимент 363cc0e вернул
// дневной текст: Волна прощается сама, бэкенд прощальную фразу не пишет (BACKEND_TOOL_RULES, «скажет голос сам»).
test('a goodbye is said by the voice: the backend only ends the call', () => {
  const voice = buildInstructions(['end_call'], '', { goodbyeWatch: true });
  assert.match(voice, /он положит трубку, а ты коротко попрощайся без вопросов/);
  assert.match(voice, /«Ядро: пользователь прощается», коротко попрощайся без вопросов;/);
  assert.match(buildBackendInstructions(['end_call']), /Прощальную фразу скажет голос сам/);
});

test('work is confirmed with the user first: the backend asks one question before work and messages to the agent', () => {
  // Звонок 23.09.2026: задания на Mac уходили без вопроса; владелец попросил сначала уточнять.
  const backend = buildBackendInstructions(['work_send', 'work_start']);
  assert.match(backend, /Подтверждение перед работой \(work_send\): сразу не запускай/);
  assert.match(backend, /только когда пользователь в ответ на такой вопрос явно согласился/);
  // С 25.09.2026 запуск большой работы — через offer_work, ядро спрашивает и запускает после «да».
  assert.match(backend, /Запуск большой работы \(work_start\): эти инструменты напрямую не зови/);
  assert.match(backend, /Ядро само предложит пользователю эту работу и запустит её после согласия/);
  assert.doesNotMatch(backend, /запускай сразу/);
  assert.doesNotMatch(buildBackendInstructions(['current_time', 'create_reminder']), /Подтверждение перед работой/);
  assert.match(buildInstructions(['work_start']), /не говори «запускаю»/);
  // Дневной промпт (363cc0e) сам описывает, как предлагать; после аудита это делала заметка ядра (offerCommentary).
  assert.match(buildInstructions(['work_start']), /Если бэкенд просит предложить работу, чётко скажи план сразу с того, что сделаешь/);
  // Когда уточнять — одно правило для всего бэкенда; частные правила на него ссылаются.
  assert.match(backend, /Уточнение: спрашивай, только когда без ответа не начать/);
  assert.equal(backend.match(/Уточнение:/g)!.length, 1);
});

test('tech card rules and the card list reach the backend only when tech card tools are in the call', () => {
  assert.doesNotMatch(buildBackendInstructions(['current_time']), /Техкарты/);
  const empty = buildBackendInstructions(['techcard_read', 'techcard_write']);
  assert.match(empty, /спроси владельца \(правило об уточнении\)/);
  assert.match(empty, /Техкарт пока нет\./);
  const listed = buildBackendInstructions(['techcard_read'], { techCards: 'Техкарты владельца: «Разработка Волны» (когда просит поправить Волну).' });
  assert.match(listed, /«Разработка Волны»/);
  assert.doesNotMatch(listed, /Техкарт пока нет/);
});

// 26.09.2026 владелец: код тоже работа, в правилах нет имени исполнителя (T3 можно заменить).
test('with an agent on the Mac all work is one work_start: code included, questions by voice, approvals only on the Mac', () => {
  const agent = buildBackendInstructions(['work_start', 'tasks_list', 'work_answer', 'work_threads', 'work_send']);
  assert.match(agent, /программирует в проектах/);
  assert.match(agent, /её запускает work_start/);
  assert.match(agent, /worktree: true\) — только по просьбе/);
  assert.match(agent, /Разрешения агенту \(команды, правка файлов\) голосом не даются/);
  assert.match(agent, /Запуск большой работы \(work_start\)/);
  assert.match(agent, /Подтверждение перед работой \(work_send\)/);
  assert.doesNotMatch(agent, /T3|t3_|Codex|кнопкой на телефоне/);
  // 05.10.2026: правил Codex и Астры больше нет, и без work_answer work_start получает те же правила агента.
  assert.doesNotMatch(buildBackendInstructions(['work_start']), /Codex|Астр|кнопкой на телефоне|действия в приложениях/);
});

// Аудит 26.09.2026: «разберусь», «займусь» ловит проверка честности; предложение работы пишет ядро (offerCommentary).
test('work rules do not put «разберусь» or «займусь» into the backend\'s mouth', () => {
  for (const tools of [['work_start'], ['work_start', 'work_answer']]) {
    assert.doesNotMatch(buildBackendInstructions(tools), /«разберусь»|«займусь»/, tools.join(','));
  }
});

test('wait music: the model is told the music is not the user only when the phone plays it and work exists', () => {
  assert.match(buildInstructions(['work_start'], '', { waitMusic: true }), /музыка без слов.*не пользователь/);
  assert.doesNotMatch(buildInstructions(['work_start']), /музыка/);
  assert.doesNotMatch(buildInstructions(['current_time'], '', { waitMusic: true }), /музыка/);
});
