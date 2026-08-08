import type { Subject } from './home-api';
import { requestJson } from './http';

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

export const browserParentsApi: ParentsApi = {
  read: () => requestJson<ParentsDashboard>('/api/parents', undefined, 'Не получилось загрузить сводку'),
};
