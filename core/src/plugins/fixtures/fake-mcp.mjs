// Поддельный MCP-сервер для тестов plugins/: stdio, сообщения построчно. Инструменты: echo, fail, slow (ждёт отмены),
// env (что видно в окружении), cancelled (какие запросы отменил клиент), crash (процесс выходит).
import { createInterface } from 'node:readline';

const cancelled = [];
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object' }, annotations: { destructiveHint: false } },
  { name: 'slow', description: 'Never answers.', inputSchema: { type: 'object' } },
  { name: 'env', description: 'Shows the environment.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'cancelled', description: 'Cancelled requests.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'crash', description: 'Exits.', inputSchema: { type: 'object' } }
];

console.log('not json: servers sometimes print to stdout');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') return void cancelled.push(message.params.requestId);
  if (message.id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  // Постранично: первая страница — два инструмента.
  if (message.method === 'tools/list') return message.params?.cursor ? reply({ tools: tools.slice(2) }) : reply({ tools: tools.slice(0, 2), nextCursor: 'p2' });
  if (message.method !== 'tools/call') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });
  const { name, arguments: args } = message.params;
  if (name === 'echo') return reply({ content: [{ type: 'text', text: `echo: ${args.text}` }, { type: 'text', text: 'second part' }] });
  if (name === 'fail') return reply({ content: [{ type: 'text', text: 'mailbox not found' }], isError: true });
  if (name === 'env') return reply({ content: [], structuredContent: { openai: process.env.OPENAI_API_KEY ?? null, token: process.env.FAKE_TOKEN ?? null, root: process.env.FAKE_ROOT ?? null } });
  if (name === 'cancelled') return reply({ content: [{ type: 'text', text: JSON.stringify(cancelled) }] });
  if (name === 'crash') process.exit(3);
  if (name === 'unknown') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } });
});
