import type { FinishRunResponse, RunProgress } from './run-api';

export type Subject = 'math' | 'russian' | 'english';

export interface PlannedRun {
  subject: Subject;
  topic: { id: string; title: string };
  priority: number;
  triagePassed: boolean;
}

export interface SubjectForecast {
  subject: Subject;
  score: number;
  band: number;
  low: number;
  high: number;
}

export interface DayPlanResponse {
  plan: PlannedRun[];
  forecasts: SubjectForecast[];
  triage: Array<{ subject: Subject; passed: boolean }>;
}

export interface ProfileSummary {
  examDate: string | null;
}

export interface StartRunResponse {
  runId: number;
  resumed: boolean;
  progress: RunProgress;
}

export interface HomeApi {
  plan(): Promise<DayPlanResponse>;
  profile(): Promise<ProfileSummary>;
  start(subject: Subject): Promise<StartRunResponse>;
  startTriage(subject: Subject): Promise<StartRunResponse>;
  finish(runId: number): Promise<FinishRunResponse>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null &&
      typeof (body as Record<string, unknown>)['error'] === 'string'
      ? (body as Record<string, string>)['error']
      : 'Сервер не смог обработать запрос';
    throw new Error(message);
  }
  return body as T;
}

function postSubject<T>(url: string, subject: Subject): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject }),
  });
}

export const browserHomeApi: HomeApi = {
  plan: () => request<DayPlanResponse>('/api/run/plan'),
  profile: () => request<ProfileSummary>('/api/profile'),
  start: (subject) => postSubject<StartRunResponse>('/api/run/start', subject),
  startTriage: (subject) => postSubject<StartRunResponse>('/api/triage/start', subject),
  finish: (runId) => request<FinishRunResponse>(`/api/run/${runId}/finish`, { method: 'POST' }),
};
