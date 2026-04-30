import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';

/**
 * Custom log level for human-actor actions ("notice") — slotted between
 * `info` (30) and `warn` (40), matching syslog conventions. Used to surface
 * manual ban / unban actions in audit-friendly logs without raising a warning.
 */
export const NOTICE_LEVEL = 35;

/**
 * Application logger type — pino with our custom `notice` level wired in.
 * Assignable to a plain `pino.Logger`, so helpers typed against the base
 * Logger interface keep working.
 */
export type AppLogger = Logger<'notice'>;

/**
 * Create a pino logger with the project's custom levels registered. Use this
 * everywhere we need a logger (production code AND tests) so `logger.notice`
 * is always available at runtime.
 */
export function createLogger(
  options: LoggerOptions<'notice'> = {},
  stream?: DestinationStream
): AppLogger {
  const merged: LoggerOptions<'notice'> = {
    ...options,
    customLevels: { notice: NOTICE_LEVEL, ...(options.customLevels ?? {}) },
  };
  return stream ? pino(merged, stream) : pino(merged);
}
