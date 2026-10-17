import { ToolRegistry, type Tool } from './registry.ts';
import { currentTime } from './current-time.ts';
import { aboutWave } from './about-wave.ts';
import { endCall } from './end-call.ts';
import { deviceTools } from './device.ts';

/**
 * Инструменты, доступные Волне в каждом звонке. Новый инструмент ядра: файл рядом и строка здесь.
 * Инструменты телефона объявлены всегда, но в сессию попадают только объявленные приложением (см. ToolRegistry.forDevice).
 * Инструменты с секретами (память, поиск) добавляет main через extra.
 */
export function defaultTools(extra: readonly Tool[] = []): ToolRegistry {
  return new ToolRegistry([currentTime, aboutWave, endCall, ...deviceTools, ...extra]);
}
