import type { DisputeResponse, RunProgress, RunTask } from './run-api';

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

export interface BossApi {
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null
      ? body as Record<string, unknown>
      : {};
    const message = typeof record['error'] === 'string'
      ? record['error']
      : 'Сервер не смог обработать бой';
    const code = typeof record['code'] === 'string' ? record['code'] : undefined;
    throw new BossApiError(message, response.status, code);
  }
  return body as T;
}

const jsonPost = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

export const browserBossApi: BossApi = {
  next: (runId) => request<NextBossTaskResponse>(`/api/boss/${runId}/next`),
  answer: (input) => request<BossAnswerResponse>(`/api/boss/${input.runId}/answer`, jsonPost({
    task_id: input.taskId,
    answer: input.answer,
    hint_used: false,
    duration_ms: input.durationMs,
  })),
  dispute: (attemptId) => request<DisputeResponse>('/api/session/dispute', jsonPost({
    attempt_id: attemptId,
  })),
  concede: (runId) => request<ConcedeBossResponse>(`/api/boss/${runId}/concede`, jsonPost()),
};
