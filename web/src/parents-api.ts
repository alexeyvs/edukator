import type { DailyGateState, Subject } from './home-api';
import { requestJson } from './http';

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
  changeComputerAccess(mode: ComputerAccessMode, pin: string): Promise<DailyGateState>;
}

export const browserParentsApi: ParentsApi = {
  read: () => requestJson<ParentsDashboard>('/api/parents', undefined, 'Не получилось загрузить сводку'),
  changeComputerAccess: (mode, pin) => requestJson<DailyGateState>(
    '/api/parents/computer-access',
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${pin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    'Не получилось изменить режим доступа',
    ({ status, message }) => new ComputerAccessError(message, status),
  ),
};
