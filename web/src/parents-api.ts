import type { Subject } from './home-api';

export type ParentsRunKind = 'run' | 'triage' | 'boss';

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
  window: { since: string; until: string };
  forecasts: ParentsForecast[];
  time: {
    plannedMinutes: number;
    actualMinutes: number;
    daily: Array<{ date: string; minutes: number }>;
  };
  gaps: Array<{ title: string; subject: Subject }>;
  activity: Array<{
    kind: ParentsRunKind;
    subject: Subject;
    startedAt: string;
    finishedAt: string;
    total: number;
    correct: number;
    activeMinutes: number;
    bossOutcome?: 'won' | 'lost';
  }>;
  flags: {
    threeFullDaysWithoutRun: boolean;
    forecastNotGrowing: Subject[];
    reduceLoad: Subject[];
  };
}

export interface ParentsApi {
  read(): Promise<ParentsDashboard>;
}

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null &&
      typeof (body as Record<string, unknown>)['error'] === 'string'
      ? (body as Record<string, string>)['error']
      : 'Не получилось загрузить сводку';
    throw new Error(message);
  }
  return body as T;
}

export const browserParentsApi: ParentsApi = {
  read: () => request<ParentsDashboard>('/api/parents'),
};
