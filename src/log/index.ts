export type LogFields = Record<string, unknown>;

export interface LogMethod {
  (msg: string, ...args: unknown[]): void;
  (fields?: LogFields, msg?: string, ...args: unknown[]): void;
}

export interface Logger {
  readonly fatal: LogMethod;
  readonly error: LogMethod;
  readonly warn: LogMethod;
  readonly info: LogMethod;
  readonly debug: LogMethod;
  readonly trace: LogMethod;
  child(bindings: LogFields): Logger;
}

const noopMethod: LogMethod = () => {};

export const noopLogger: Logger = {
  fatal: noopMethod,
  error: noopMethod,
  warn: noopMethod,
  info: noopMethod,
  debug: noopMethod,
  trace: noopMethod,
  child: () => noopLogger,
};
