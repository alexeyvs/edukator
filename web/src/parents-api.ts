import type { DailyGateState, Subject } from './home-api';
import { requestJson } from './http';
import type { IntegrityStatusResponse } from './run-api';

export type ComputerAccessMode = 'automatic' | 'blocked' | 'unlocked';

export class ComputerAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ComputerAccessError';
  }
}

export type ParentsRunKind = 'run' | 'triage' | 'boss' | 'lesson';

export interface ParentsForecast {
  subject: Subject;
  score: number;
  band: number;
  low: number;
  high: number;
  preliminary: boolean;
  currentSnapshot?: { score: number; band: number; createdAt: string };
  delta?: number;
}

export interface ParentsDashboard {
  generatedAt: string;
  computerAccess: DailyGateState & { configured: boolean };
  window: { since: string; until: string };
  forecasts: ParentsForecast[];
  time: {
    plannedMinutes: number;
    actualMinutes: number;
    daily: Array<{ date: string; minutes: number }>;
  };
  gaps: Array<{ title: string; subject: Subject }>;
  activity: Array<{
    runId: number;
    kind: ParentsRunKind;
    subject: Subject;
    startedAt: string;
    finishedAt: string;
    total: number;
    correct: number;
    activeMinutes: number;
    bossOutcome?: 'won' | 'lost';
  }>;
  integrityReviews?: Array<{
    runId: number;
    kind: 'run' | 'lesson';
    subject: Subject;
    startedAt: string;
    status: 'screening' | 'reviewing' | 'needs_retry' | 'passed';
    flagged: number;
    retryRequired: number;
  }>;
  flags: {
    threeFullDaysWithoutRun: boolean;
    forecastNotGrowing: Subject[];
    reduceLoad: Subject[];
  };
}

export interface ParentsRunAttempt {
  number: number;
  topicTitle: string;
  answerFormat: 'number' | 'text' | 'choice';
  question: string;
  instruction?: string;
  material?: string;
  materialFormat?: 'none' | 'text' | 'math';
  choices: string[];
  studentAnswer: string;
  correctAnswer: string;
  explanation: string;
  hint?: string;
  correct: boolean;
  correction: boolean;
  durationMilliseconds: number;
  answeredAt: string;
  current?: boolean;
  integrity?: {
    itemId: number;
    status: 'pending' | 'retry_required' | 'approved';
    decision?: 'meaningful' | 'doubtful' | 'junk';
    confidence?: number;
    reason?: string;
    reviewedBy?: 'codex' | 'parent' | 'heuristic';
  };
}

export interface ParentsRunDetail {
  runId: number;
  kind: ParentsRunKind;
  subject: Subject;
  startedAt: string;
  finishedAt?: string;
  total: number;
  correct: number;
  activeMilliseconds: number;
  attempts: ParentsRunAttempt[];
  integrityStatus?: 'screening' | 'reviewing' | 'needs_retry' | 'passed';
}

export interface ParentsApi {
  read(): Promise<ParentsDashboard>;
  readRun(runId: number): Promise<ParentsRunDetail>;
  /**
   * PIN не обязателен: он подтверждает родителя за детской машиной, а вошедшей
   * родительской сессии сервер его не спрашивает. Пустой заголовок вместо
   * отсутствующего означал бы «прислал неверный PIN» и получал бы 401.
   */
  changeComputerAccess(mode: ComputerAccessMode, pin?: string): Promise<DailyGateState>;
  approveIntegrity(runId: number, itemId: number, pin?: string): Promise<IntegrityStatusResponse>;
}

/**
 * Сводка конкретного ребёнка. Ребёнок назван в адресе, а не берётся из
 * предъявителя: у родителя их несколько, и «сводка того, чья cookie пришла»
 * оставляла бы его без способа узнать, чей отчёт он читает.
 */
export function parentsApiFor(childId: string): ParentsApi {
  const base = `/api/parents/${encodeURIComponent(childId)}`;
  return {
    read: () => requestJson<ParentsDashboard>(base, undefined, 'Не получилось загрузить сводку'),
    readRun: (runId) => requestJson<ParentsRunDetail>(
      `${base}/runs/${String(runId)}`,
      undefined,
      'Не получилось загрузить занятие',
    ),
    changeComputerAccess: (mode, pin) => requestJson<DailyGateState>(
      `${base}/computer-access`,
      {
        method: 'PUT',
        headers: {
          ...(pin === undefined ? {} : { authorization: `Bearer ${pin}` }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode }),
      },
      'Не получилось изменить режим доступа',
      ({ status, message }) => new ComputerAccessError(message, status),
      // 401 здесь значит разное в зависимости от того, был ли предъявлен PIN.
      // С PIN это «не тот PIN», и выкидывать за него со сводки нельзя. Без PIN
      // (родительская сессия его не предъявляет вовсе) 401 может означать
      // только «сессии больше нет» — и тогда нужен экран входа, а не красная
      // строка под кнопкой. См. `http.ts`.
      { signedOutOn401: pin === undefined, signedOutOnUnauthenticated: true },
    ),
    approveIntegrity: (runId, itemId, pin) => requestJson<IntegrityStatusResponse>(
      `${base}/runs/${String(runId)}/integrity/${String(itemId)}/approve`,
      {
        method: 'PUT',
        headers: pin === undefined ? {} : { authorization: `Bearer ${pin}` },
      },
      'Не получилось подтвердить ответ',
      ({ status, message }) => new ComputerAccessError(message, status),
      { signedOutOn401: pin === undefined, signedOutOnUnauthenticated: true },
    ),
  };
}
