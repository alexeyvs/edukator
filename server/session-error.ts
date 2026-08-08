/** Причина отказа: по ней маршрут выбирает код ответа. */
export type SessionErrorCode =
  | 'task-not-found'
  | 'task-not-issued'
  | 'already-answered'
  | 'attempt-not-found'
  | 'attempt-correct'
  | 'dispute-not-found'
  | 'run-not-found'
  | 'run-finished'
  | 'task-not-in-run'
  /** Задание отбраковано при приёме ответа: сверить его не по чему. */
  | 'task-defective';

/** Отказ по состоянию занятия, а не по поломке: маршрут отвечает на него 4xx. */
export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}
