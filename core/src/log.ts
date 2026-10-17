// Логгер ядра. Инвариант: в лог попадают только имена событий, статусы и имена инструментов.
// Никогда: SDP, тексты разговора, аргументы инструментов, ключи и токены.
export interface Logger {
  info(message: string, fields?: Record<string, string | number | boolean | null>): void;
  warn(message: string, fields?: Record<string, string | number | boolean | null>): void;
}

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(format(message, fields)),
  warn: (message, fields) => console.warn(format(message, fields))
};

export const silentLogger: Logger = { info() {}, warn() {} };

function format(message: string, fields?: Record<string, unknown>): string {
  const extra = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(' ') : '';
  return `[core] ${message}${extra}`;
}
