export type AnswerFormat = 'number' | 'text' | 'choice';

export interface RunProgress {
  total: number;
  correct: number;
  target: number;
  done: boolean;
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
}

export interface AnswerResponse {
  attempt_id: number;
  correct: boolean;
  normalized: string;
  reason?: string;
  answer: string;
  explain: string;
  joke: string;
  xp: number;
  progress: RunProgress;
}

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
}

export interface RunApi {
  next(runId: number, excludeTaskId?: number): Promise<NextTaskResponse>;
  answer(input: {
    runId: number;
    taskId: number;
    answer: string;
    hintUsed: boolean;
    durationMs: number;
  }): Promise<AnswerResponse>;
  dispute(attemptId: number): Promise<DisputeResponse>;
  finish(runId: number): Promise<FinishRunResponse>;
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
  })),
  dispute: (attemptId) => request<DisputeResponse>('/api/session/dispute', jsonRequest('POST', { attempt_id: attemptId })),
  finish: (runId) => request<FinishRunResponse>(`/api/run/${runId}/finish`, jsonRequest('POST')),
  triageNext: (runId) => request<NextTriageResponse>(`/api/triage/${runId}/next`),
};
import { jsonRequest, requestJson } from './http';
