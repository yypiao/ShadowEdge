/** 结构化日志接口。实现由宿主注入（主进程写文件，服务端写 stdout/JSON）。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  child(fields: LogFields): Logger;
  log(level: LogLevel, message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** 敏感字段脱敏键名，日志与审计写入前统一过滤。 */
export const REDACTED_KEYS = new Set([
  'password',
  'secret',
  'secretRef',
  'token',
  'cookie',
  'cookies',
  'authorization',
  'privateKey',
]);

export const redact = <T extends LogFields>(fields: T): LogFields => {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : value;
  }
  return out;
};

export const createConsoleLogger = (base: LogFields = {}): Logger => {
  const make = (fields: LogFields): Logger => ({
    child: (extra) => make({ ...fields, ...extra }),
    log(level, message, extra) {
      const payload = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        ...redact({ ...fields, ...extra }),
      });
      if (level === 'error') console.error(payload);
      else if (level === 'warn') console.warn(payload);
      else console.log(payload);
    },
    debug(message, extra) {
      this.log('debug', message, extra);
    },
    info(message, extra) {
      this.log('info', message, extra);
    },
    warn(message, extra) {
      this.log('warn', message, extra);
    },
    error(message, extra) {
      this.log('error', message, extra);
    },
  });
  return make(base);
};
