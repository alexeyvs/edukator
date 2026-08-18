export type AnswerFormat = 'number' | 'text' | 'choice';

export interface RunProgress {
  total: number;
  correct: number;
  target: number;
  done: boolean;
  lives?: {
    total: 3;
    remaining: number;
    retryAvailable: boolean;
  };
}

export interface RunTask {
  id: number;
  topic_id: string;
  topic_title: string;
  subject: 'math' | 'russian' | 'english';
  question: string;
  instruction?: string;
  material?: string;
  material_format?: 'none' | 'text' | 'math';
  choices?: string[];
  hint?: string;
  difficulty: number;
  answer_format: AnswerFormat;
}

export interface NextTaskResponse {
  task: RunTask;
  progress: RunProgress;
  retry?: {
    attempt_id: number;
    previous_answer: string;
    answer: string;
    explain: string;
    joke: string;
    dispute_status?: DisputeStatus;
  };
}

export interface AnswerResponse {
  attempt_id: number;
  integrity_check?: boolean;
  correct: boolean;
  normalized: string;
  reason?: string;
  answer?: string;
  explain?: string;
  joke?: string;
  xp: number;
  progress: RunProgress;
}

export type IntegrityStatusResponse =
  | { status: 'checking'; flagged: number }
  | {
      status: 'retry_required';
      flagged: number;
      remaining: number;
      retry: { item_id: number; task: RunTask };
    }
  | { status: 'completed'; result: FinishRunResponse | Record<string, unknown> };

export type FinishRunApiResponse = FinishRunResponse | Exclude<IntegrityStatusResponse, { status: 'completed' }>;

export interface RunTopicChange {
  topicId: string;
  title: string;
  before: number;
  after: number;
}

export interface ForecastSnapshot {
  id: number;
  subject: 'math' | 'russian' | 'english' | 'overall';
  score: number;
  band: number;
  createdAt: string;
}

export interface FinishRunResponse {
  runId: number;
  total: number;
  correct: number;
  xp: number;
  touchedTopics: RunTopicChange[];
  closedTopics: RunTopicChange[];
  declinedTopics: RunTopicChange[];
  forecast: ForecastSnapshot;
  forecastDelta?: number;
}

export type NextTriageResponse =
  | { status: 'ok'; task: Omit<RunTask, 'hint'>; progress: RunProgress }
  | { status: 'done'; total: number; target: number };

export type DisputeStatus = 'open' | 'upheld' | 'rejected';

export interface DisputeResponse {
  dispute_id: number;
  status: DisputeStatus;
  progress?: RunProgress | null;
  xp?: number;
}

export interface RunApi {
  next(runId: number, excludeTaskId?: number): Promise<NextTaskResponse>;
  answer(input: {
    runId: number;
    taskId: number;
    answer: string;
    hintUsed: boolean;
    durationMs: number;
    retryAttemptId?: number;
  }): Promise<AnswerResponse>;
  skipRetry(runId: number, taskId: number): Promise<{ progress: RunProgress }>;
  dispute(attemptId: number): Promise<DisputeResponse>;
  finish(runId: number): Promise<FinishRunApiResponse>;
  integrity?(runId: number): Promise<IntegrityStatusResponse>;
  retryIntegrity?(input: {
    runId: number;
    itemId: number;
    answer: string;
    durationMs: number;
    hintUsed: boolean;
  }): Promise<IntegrityStatusResponse>;
  triageNext(runId: number): Promise<NextTriageResponse>;
}

export class RunApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RunApiError';
  }
}

const request = <T>(url: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(url, init, 'Сервер не смог обработать запрос', ({ message, status, code }) =>
    new RunApiError(message, status, code));

export const browserRunApi: RunApi = {
  next: (runId, excludeTaskId) => request<NextTaskResponse>(
    `/api/session/next?runId=${runId}${excludeTaskId === undefined ? '' : `&excludeTaskId=${excludeTaskId}`}`,
  ),
  answer: (input) => request<AnswerResponse>('/api/session/answer', jsonRequest('POST', {
      runId: input.runId,
      task_id: input.taskId,
      answer: input.answer,
      hint_used: input.hintUsed,
      duration_ms: input.durationMs,
      ...(input.retryAttemptId === undefined
        ? {}
        : { retry_attempt_id: input.retryAttemptId }),
  })),
  skipRetry: (runId, taskId) => request<{ progress: RunProgress }>(
    '/api/session/retry/skip',
    jsonRequest('POST', { runId, task_id: taskId }),
  ),
  dispute: (attemptId) => request<DisputeResponse>('/api/session/dispute', jsonRequest('POST', { attempt_id: attemptId })),
  finish: (runId) => request<FinishRunApiResponse>(`/api/run/${runId}/finish`, jsonRequest('POST')),
  integrity: (runId) => request<IntegrityStatusResponse>(`/api/integrity/${runId}`),
  retryIntegrity: (input) => request<IntegrityStatusResponse>(
    `/api/integrity/${input.runId}/retry/${input.itemId}`,
    jsonRequest('POST', {
      answer: input.answer,
      duration_ms: input.durationMs,
      hint_used: input.hintUsed,
    }),
  ),
  triageNext: (runId) => request<NextTriageResponse>(`/api/triage/${runId}/next`),
};
import { jsonRequest, requestJson } from './http';
