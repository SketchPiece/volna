import { z } from 'zod';
import type { Logger } from '../../log.ts';

/** Что инструмент получает от ядра при вызове. Без доступа к SDP, ключам и тексту разговора. */
export interface ToolContext {
  callId: string;
  signal: AbortSignal;
  log: Logger;
  timeZone: string;
  now(): Date;
  /** Просит ядро закрыть сессию после прощания Волны. Есть только у инструментов, исполняемых в sideband. */
  endCall?: () => void;
  /** Стенограмма звонка до последней реплики пользователя (realtime/conversation.ts); только в sideband. */
  turns?: () => readonly { role: 'user' | 'assistant'; text: string }[];
}

/**
 * Что делает инструмент. `read` только читает; `write` меняет данные пользователя (напоминание, память);
 * `act` действует вовне или тратит деньги и токены (сообщение агенту, новый чат). Быстрый путь Jev зовёт только `read`.
 */
export type ToolEffect = 'read' | 'write' | 'act';

/**
 * Карточка для Jev: с ней инструмент попадает в быстрый путь (ядро исполняет его без LLM, docs/tools-routing.md).
 * Для `read`, когда все аргументы выбираются из вариантов. Исключение с 23.09.2026: `act` с `verbatim`, где свободный
 * текст — дословные слова пользователя (был у computer_start до 23.09.2026; сейчас таких инструментов нет: работу Волна сначала уточняет).
 */
export interface JevCard {
  /** Когда инструмент нужен; это читает Jev. */
  when: string;
  /** Аргументы-выборы: имя аргумента → вопрос и варианты. */
  args?: Record<string, { instructions: string; options: Record<string, string> }>;
  /** Постоянные аргументы. */
  fixed?: Record<string, unknown>;
  /**
   * Аргумент `arg` ядро заполняет дословно последними репликами пользователя (с парой предыдущих для контекста),
   * `title` — началом просьбы. Такой быстрый путь срабатывает, только если Jev считает задачу простой (класс `simple`).
   */
  verbatim?: { arg: string; title?: string };
  /** Свой порог уверенности вместо JEV_TOOL_THRESHOLD. */
  threshold?: number;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  /** Имя для модели: латиница и подчёркивания. */
  name: string;
  /** Когда модель должна звать инструмент; модель читает это описание. */
  description: string;
  parameters: S;
  /**
   * Готовая JSON Schema аргументов вместо схемы из `parameters`: у инструментов MCP-серверов плагинов (plugins/runtime.ts)
   * схему задаёт сервер, а `parameters` пропускает любой объект.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * Нужен в каждом звонке, какую бы техкарту ни выбрал Jev: завершение звонка, чтение и правка техкарт.
   * Остальные инструменты модель видит, только если их называет выбранная техкарта (`allowed-tools`, docs/skills.md).
   */
  always?: boolean;
  effect: ToolEffect;
  /**
   * Запускает большую работу (задание в фоне, новый чат агента). Модель не зовёт такой инструмент сама: она предлагает
   * работу через `offer_work`, Волна спрашивает с планом «<что сделаю>. Сделать?», и после «да» ядро
   * запускает его сам (delegation/client.ts). Так подтверждение перед работой держится в коде, а не в тексте промпта.
   */
  startsWork?: boolean;
  jev?: JevCard;
  /**
   * Где исполняется инструмент. `core` (по умолчанию): ядро по sideband. `device`: приложение на iPhone по data channel;
   * ядро держит определение, чтобы модель его видела, но никогда не исполняет и молчит на такие вызовы.
   */
  runsOn?: 'core' | 'device';
  execute(args: z.output<S>, context: ToolContext): Promise<unknown> | unknown;
}

/** Служебная функция маршрутизатора (delegation/client.ts): модель просит больше инструментов или модель сильнее. */
export const ESCALATE = 'escalate';
/** Служебные функции предложения работы (delegation/client.ts): предложить и запустить предложенное после «да». */
export const OFFER_WORK = 'offer_work';
export const START_OFFERED = 'start_offered_work';
const RESERVED = [ESCALATE, OFFER_WORK, START_OFFERED];

/** Определение с выводом типа аргументов из схемы. */
export function defineTool<S extends z.ZodObject>(tool: Tool<S>): Tool<S> {
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
  if (RESERVED.includes(tool.name)) throw new Error(`${tool.name} is reserved for routing`);
  if (tool.jev) {
    if (tool.effect !== 'read' && !tool.jev.verbatim) throw new Error(`Jev card on ${tool.name}: the fast path runs read tools, or act tools with the user's own words`);
    const shape = tool.parameters.shape;
    const verbatim = tool.jev.verbatim ? [tool.jev.verbatim.arg, ...(tool.jev.verbatim.title ? [tool.jev.verbatim.title] : [])] : [];
    for (const arg of [...Object.keys(tool.jev.args ?? {}), ...Object.keys(tool.jev.fixed ?? {}), ...verbatim]) {
      if (!(arg in shape)) throw new Error(`Jev card of ${tool.name} names unknown argument ${arg}`);
    }
  }
  return tool;
}

/** Описание инструмента в формате OpenAI Realtime `session.tools`. */
export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.#tools.set(tool.name, tool as Tool);
    }
  }

  get size(): number { return this.#tools.size; }
  names(): string[] { return [...this.#tools.keys()]; }
  /** Имена инструментов, которые исполняет телефон. */
  deviceNames(): string[] { return [...this.#tools.values()].filter(t => t.runsOn === 'device').map(t => t.name); }
  runsOnDevice(name: string): boolean { return this.#tools.get(name)?.runsOn === 'device'; }

  /**
   * Реестр для конкретного звонка: инструменты ядра целиком плюс только те инструменты телефона,
   * которые приложение объявило в заголовке `X-Device-Tools` (значит, доступ к ним дан).
   */
  forDevice(announced: readonly string[]): ToolRegistry {
    return new ToolRegistry([...this.#tools.values()].filter(tool => tool.runsOn !== 'device' || announced.includes(tool.name)));
  }

  /** Реестр с добавленными инструментами (например, поиск ядра при своём делегировании). */
  with(extra: readonly Tool[]): ToolRegistry {
    return new ToolRegistry([...this.#tools.values(), ...extra]);
  }

  /**
   * Реестр только из названных инструментов (`allowed-tools` техкарты) и инструментов `always`.
   * Имя с `*` на конце — все инструменты с таким началом: `gmail_*` берёт инструменты плагина gmail.
   */
  only(names: readonly string[]): ToolRegistry {
    const prefixes = names.filter(name => name.length > 1 && name.endsWith('*')).map(name => name.slice(0, -1));
    return new ToolRegistry([...this.#tools.values()].filter(tool => names.includes(tool.name) || tool.always || prefixes.some(prefix => tool.name.startsWith(prefix))));
  }

  has(name: string): boolean { return this.#tools.has(name); }
  /** Инструменты, которые запускают большую работу только через предложение (`startsWork`). */
  startNames(): string[] { return [...this.#tools.values()].filter(t => t.startsWork).map(t => t.name); }
  /** Проблемы аргументов по схеме инструмента; пусто, если аргументы годятся. */
  issues(name: string, args: unknown): string[] {
    const tool = this.#tools.get(name);
    if (!tool) return [`unknown tool ${name}`];
    const parsed = tool.parameters.safeParse(args);
    return parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
  }
  effectOf(name: string): ToolEffect | undefined { return this.#tools.get(name)?.effect; }

  /** Только читающие инструменты ядра: так исполнитель фоновых заданий не действует от имени пользователя без него. */
  readOnly(): ToolRegistry {
    return new ToolRegistry([...this.#tools.values()].filter(tool => tool.effect === 'read' && tool.runsOn !== 'device'));
  }

  /** Инструменты с карточкой Jev: кандидаты быстрого пути. */
  jevCandidates(): { name: string; card: JevCard }[] {
    return [...this.#tools.values()].filter(tool => tool.jev).map(tool => ({ name: tool.name, card: tool.jev! }));
  }

  /** Реестр без указанных инструментов: так уровень «Холодная» убирает память из сессии. */
  without(names: readonly string[]): ToolRegistry {
    return new ToolRegistry([...this.#tools.values()].filter(tool => !names.includes(tool.name)));
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema ?? compactSchema(z.toJSONSchema(tool.parameters, { target: 'draft-7' }))
    }));
  }

  /**
   * Выполняет инструмент по имени и JSON-строке аргументов от модели.
   * Всегда возвращает JSON-строку: ошибки тоже уходят модели структурировано, чтобы она честно сказала о сбое.
   */
  async call(name: string, rawArguments: string, context: ToolContext): Promise<string> {
    const tool = this.#tools.get(name);
    if (!tool) return JSON.stringify({ error: 'unknown_tool', name });
    let parsedArguments: unknown;
    try { parsedArguments = rawArguments.trim() ? JSON.parse(rawArguments) : {}; }
    catch { return JSON.stringify({ error: 'invalid_arguments', detail: 'Arguments are not valid JSON.' }); }
    const args = tool.parameters.safeParse(parsedArguments);
    if (!args.success) {
      return JSON.stringify({ error: 'invalid_arguments', issues: args.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    }
    try {
      const result = await tool.execute(args.data, context);
      return JSON.stringify(result ?? { ok: true });
    } catch (error) {
      context.log.warn('tool failed', { tool: name, error: error instanceof Error ? error.name : 'unknown' });
      return JSON.stringify({ error: 'tool_failed', name });
    }
  }
}

/**
 * Схема без служебного: `$schema` в каждом инструменте и описание, которое zod повторяет внутри ветки `anyOf`
 * (у nullable-полей). Модели это не нужно, а у 24 инструментов это ~10% описаний (замер 25.09.2026).
 */
export function compactSchema(node: unknown, parentDescription?: unknown): any {
  if (Array.isArray(node)) return node.map(item => compactSchema(item, parentDescription));
  if (typeof node !== 'object' || node === null) return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === '$schema') continue;
    if (key === 'description' && parentDescription !== undefined && value === parentDescription) continue;
    out[key] = key === 'anyOf' || key === 'oneOf' ? compactSchema(value, record.description) : compactSchema(value);
  }
  return out;
}
