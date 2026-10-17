import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

test('defaults keep the core on localhost with the current model', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.model, 'gpt-live-1');
  assert.equal(config.webSearch, true);
  assert.equal(config.apiKey, '');
  assert.ok(config.timeZone.length > 0);
});

test('listening beyond localhost requires a core token', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /BRIDGE_TOKEN/);
  assert.equal(loadConfig({ HOST: '0.0.0.0', BRIDGE_TOKEN: 't', PORT: '9000' }).port, 9000);
});

test('metrics and Jev settings: metrics on, Jev off without a key and on with one', () => {
  const config = loadConfig({});
  assert.equal(config.metricsDir, 'data/metrics');
  assert.equal(config.jev.mode, 'off');
  assert.equal(loadConfig({ METRICS: 'off' }).metricsDir, null);
  const withKey = loadConfig({ TYPESAFE_API_KEY: 'ts', JEV_TOOL_THRESHOLD: '0.7' });
  assert.equal(withKey.jev.mode, 'on');
  assert.equal(withKey.jev.toolThreshold, 0.7);
  assert.equal(withKey.jev.routeThreshold, 0.6);
  assert.equal(loadConfig({ TYPESAFE_API_KEY: 'ts', JEV_MODE: 'shadow' }).jev.mode, 'shadow');
});

test('Jev through OpenRouter when only its key is set; the TypeSafe key wins when both are', () => {
  const viaRouter = loadConfig({ OPEN_ROUTER_API_KEY: 'or' }).jev;
  assert.deepEqual([viaRouter.provider, viaRouter.apiKey, viaRouter.model, viaRouter.mode], ['openrouter', 'or', 'typesafe/jev-1.13', 'on']);
  assert.equal(loadConfig({ OPENROUTER_API_KEY: 'or2' }).jev.apiKey, 'or2');
  const both = loadConfig({ OPEN_ROUTER_API_KEY: 'or', TYPESAFE_API_KEY: 'ts' }).jev;
  assert.deepEqual([both.provider, both.apiKey, both.model], ['typesafe', 'ts', 'jev-latest']);
  assert.equal(loadConfig({ OPEN_ROUTER_API_KEY: 'or', JEV_MODEL: 'jev-1.13' }).jev.model, 'jev-1.13');
  assert.deepEqual(loadConfig({ OPEN_ROUTER_API_KEY: 'or' }).clientDelegation, {
    apiKey: 'or',
    openAiKey: null,
    models: { simple: 'google/gemini-3.5-flash-lite', standard: 'openai/gpt-5.6-luna' },
    searchModel: 'google/gemini-3.5-flash-lite'
  });
  assert.equal(loadConfig({ OPEN_ROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oa' }).clientDelegation!.openAiKey, 'oa', 'openai/* straight to OpenAI with the Live key');
  assert.equal(loadConfig({ OPEN_ROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oa', CLIENT_OPENAI_DIRECT: 'off' }).clientDelegation!.openAiKey, null);
  assert.equal(loadConfig({ OPEN_ROUTER_API_KEY: 'or', CLIENT_MODEL_STANDARD: 'openai/gpt-5.6' }).clientDelegation!.models.standard, 'openai/gpt-5.6');
  assert.equal(loadConfig({}).clientDelegation, null, 'no OpenRouter key: no delegation, calls are refused');
});

test('Helm is off without a token; with one it reads URL, folder, instance and a safe runtime mode', () => {
  assert.equal(loadConfig({}).helm, null);
  const helm = loadConfig({ HELM_TOKEN: 'tok', HELM_PROJECT_DIR: '~/Work' }).helm;
  assert.equal(helm?.url, 'http://127.0.0.1:3783');
  assert.equal(helm?.token, 'tok');
  assert.ok(helm?.projectDir.endsWith('/Work') && !helm.projectDir.startsWith('~'));
  assert.deepEqual([helm?.instance, helm?.model, helm?.runtimeMode], ['claudeAgent', null, 'auto']);
  const codex = loadConfig({ HELM_TOKEN: 'tok', HELM_INSTANCE: 'codex', HELM_MODEL: 'gpt-6-astra', HELM_RUNTIME_MODE: 'approval-required' }).helm;
  assert.deepEqual([codex?.instance, codex?.model, codex?.runtimeMode], ['codex', 'gpt-6-astra', 'approval-required']);
  assert.throws(() => loadConfig({ HELM_TOKEN: 'tok', HELM_RUNTIME_MODE: 'full-access' }), 'bypass is never configured');
});

test('Helm pushes need two distinct Helm tokens and never borrow the relay token', () => {
  assert.equal(loadConfig({ RELAY_TOKEN: 'r', HELM_PROJECT_DIR: '/w', HELM_NEW_PROJECTS_DIR: '/p' }).helmPush, null);
  assert.equal(loadConfig({ HELM_SERVER_TOKEN: 's' }).helmPush, null);
  assert.equal(loadConfig({ HELM_SERVER_TOKEN: 'same', HELM_DEVICE_TOKEN: 'same' }).helmPush, null);
  assert.deepEqual(loadConfig({ HELM_SERVER_TOKEN: 's', HELM_DEVICE_TOKEN: 'd' }).helmPush, { serverToken: 's', deviceToken: 'd', transcribeModel: 'gpt-transcribe' });

test('the old T3_* names of the Helm variables still work; the new name wins', () => {
  const old = loadConfig({ T3_TOKEN: 'old', T3_PROJECT_DIR: '/w', T3_STALL_MINUTES: '7' });
  assert.equal(old.helm?.token, 'old');
  assert.equal(old.helm?.projectDir, '/w');
  assert.equal(old.helm?.stallMs, 7 * 60_000);
  assert.equal(loadConfig({ T3_TOKEN: 'old', HELM_TOKEN: 'new' }).helm?.token, 'new');
  assert.equal(loadConfig({ RELAY_TOKEN: 'r', T3_PROJECT_DIR: '/Users/me/Work', T3_NEW_PROJECTS_DIR: '/Users/me' }).helm?.projectDir, '/Users/me/Work');
});
});
