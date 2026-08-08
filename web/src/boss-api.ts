import type { DisputeResponse, RunProgress, RunTask } from './run-api';
import { jsonRequest, requestJson } from './http';

export type BossTask = Omit<RunTask, 'hint'>;

export interface NextBossTaskResponse {
  batchId: number;
  runId: number;
  position: number;
  task: BossTask;
}

export interface BossAnswerResponse {
  attemptId: number;
  correct: boolean;
  normalized: string;
  reason?: string;
  answer: string;
  explain: string;
  joke: string;
  xp: number;
  outcome: 'active' | 'mistake' | 'won';
  progress: RunProgress;
}

export interface ConcedeBossResponse {
  runId: number;
  batchId: number;
  replacementBatchId: number;
}

export type BossFightStateResponse =
  | { outcome: 'active'; progress: RunProgress }
  | { outcome: 'mistake' | 'dispute'; attemptId: number; progress: RunProgress }
  | { outcome: 'won' | 'lost'; progress: RunProgress };

export interface BossApi {
  state(runId: number): Promise<BossFightStateResponse>;
  next(runId: number): Promise<NextBossTaskResponse>;
  answer(input: {
    runId: number;
    taskId: number;
    answer: string;
    durationMs: number;
  }): Promise<BossAnswerResponse>;
  dispute(attemptId: number): Promise<DisputeResponse>;
  concede(runId: number): Promise<ConcedeBossResponse>;
}

export class BossApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BossApiError';
  }
}

const request = <T>(url: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(url, init, 'Сервер не смог обработать бой', ({ message, status, code }) =>
    new BossApiError(message, status, code));

export const browserBossApi: BossApi = {
  state: (runId) => request<BossFightStateResponse>(`/api/boss/${runId}/state`),
  next: (runId) => request<NextBossTaskResponse>(`/api/boss/${runId}/next`),
  answer: (input) => request<BossAnswerResponse>(`/api/boss/${input.runId}/answer`, jsonRequest('POST', {
    task_id: input.taskId,
    answer: input.answer,
    hint_used: false,
    duration_ms: input.durationMs,
  })),
  dispute: (attemptId) => request<DisputeResponse>('/api/session/dispute', jsonRequest('POST', {
    attempt_id: attemptId,
  })),
  concede: (runId) => request<ConcedeBossResponse>(`/api/boss/${runId}/concede`, jsonRequest('POST')),
};
