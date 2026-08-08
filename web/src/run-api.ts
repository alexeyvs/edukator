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
  hint: string;
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

export type DisputeStatus = 'open' | 'upheld' | 'rejected';

export interface DisputeResponse {
  dispute_id: number;
  status: DisputeStatus;
}

export interface RunApi {
  next(runId: number): Promise<NextTaskResponse>;
  answer(input: {
    runId: number;
    taskId: number;
    answer: string;
    hintUsed: boolean;
    durationMs: number;
  }): Promise<AnswerResponse>;
  dispute(attemptId: number): Promise<DisputeResponse>;
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null
      ? body as Record<string, unknown>
      : {};
    const message = typeof record['error'] === 'string'
      ? record['error']
      : 'Сервер не смог обработать запрос';
    const code = typeof record['code'] === 'string' ? record['code'] : undefined;
    throw new RunApiError(message, response.status, code);
  }
  return body as T;
}

export const browserRunApi: RunApi = {
  next: (runId) => request<NextTaskResponse>(`/api/session/next?runId=${runId}`),
  answer: (input) => request<AnswerResponse>('/api/session/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: input.runId,
      task_id: input.taskId,
      answer: input.answer,
      hint_used: input.hintUsed,
      duration_ms: input.durationMs,
    }),
  }),
  dispute: (attemptId) => request<DisputeResponse>('/api/session/dispute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attempt_id: attemptId }),
  }),
};
