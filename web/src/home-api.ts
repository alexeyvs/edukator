import type { FinishRunApiResponse, RunProgress } from './run-api';
import { jsonRequest, requestJson } from './http';

export type CourseId = string;
/** Совместимое имя поля API: subject теперь содержит произвольный CourseId. */
export type Subject = CourseId;

export interface CourseSummary {
  courseId: CourseId;
  title: string;
  grade: string;
  revision: number | null;
}

export interface PlannedRun {
  subject: Subject;
  courseId?: CourseId;
  courseTitle?: string;
  grade?: string;
  topic: { id: string; title: string };
  priority: number;
  triagePassed: boolean;
  active?: {
    runId: number;
    startedAt: string;
    progress: RunProgress;
  };
}

export interface SubjectForecast {
  subject: Subject;
  courseId?: CourseId;
  courseTitle?: string;
  grade?: string;
  score: number;
  band: number;
  low: number;
  high: number;
}

export interface Streak {
  current: number;
  best: number;
  completedToday: boolean;
}

export interface DailyGateState {
  day: string;
  required: number;
  completed: number;
  remaining: number;
  learning: {
    materialId: number | null;
    required: boolean;
    passed: boolean;
  };
  automaticUnlocked: boolean;
  override: {
    mode: 'blocked' | 'unlocked';
    changedAt: string;
    expiresAt: string;
  } | null;
  unlocked: boolean;
}

export type BossReadiness =
  | { status: 'working'; eligible: boolean }
  | { status: 'closed'; eligible: false }
  | { status: 'preparing' | 'ready'; eligible: boolean; batchId: number }
  | { status: 'active'; eligible: boolean; batchId: number; runId: number };

export interface HomeTopic {
  id: string;
  title: string;
  subject: Subject;
  courseId?: CourseId;
  courseTitle?: string;
  grade?: string;
  bossProgress: number;
  readiness: BossReadiness;
}

export interface LearningMaterialCard {
  id: number;
  subject: Subject;
  courseId?: CourseId;
  courseTitle?: string;
  grade?: string;
  topic: { id: string; title: string };
  recommendationReason: string;
  estimatedMinutes: number;
  status: 'ready' | 'active';
}

export interface DayPlanResponse {
  courses: CourseSummary[];
  empty?: boolean;
  plan: PlannedRun[];
  learning: LearningMaterialCard[];
  forecasts: SubjectForecast[];
  triage: Array<{ subject: Subject; passed: boolean; needed: boolean }>;
  streak: Streak;
  topics: HomeTopic[];
  gate: DailyGateState;
}

export interface ProfileSummary {
  examDate: string | null;
}

export interface StartRunResponse {
  runId: number;
  resumed: boolean;
  progress: RunProgress;
}

export interface StartBossResponse {
  batchId: number;
  runId: number;
  resumed: boolean;
}

export interface HomeApi {
  plan(): Promise<DayPlanResponse>;
  profile(): Promise<ProfileSummary>;
  start(subject: Subject, topicId: string): Promise<StartRunResponse>;
  startBoss(topicId: string): Promise<StartBossResponse>;
  startTriage(subject: Subject): Promise<StartRunResponse>;
  /**
   * Тот же `POST /api/run/:id/finish`, что и у `RunApi`, и тип обязан быть тем
   * же самым — `FinishRunApiResponse`, а не одна лишь сводка. Маршрут на
   * отвеченном забеге сперва запускает проверку осмысленности и отвечает
   * `checking` либо `retry_required`; своя, укороченная копия контракта эти
   * ветки от компилятора прятала, и главный экран отдавал их `FinishScreen`
   * как сводку — то есть падал в пустой экран ровно на забеге, который просят
   * завершить. Тип здесь один на оба контракта намеренно: вторая копия
   * разъезжается с первой молча.
   */
  finish(runId: number): Promise<FinishRunApiResponse>;
}

const request = <T>(url: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(url, init, 'Сервер не смог обработать запрос');

function postSubject<T>(url: string, subject: Subject): Promise<T> {
  return request<T>(url, jsonRequest('POST', { subject }));
}

function postPlannedRun<T>(subject: Subject, topicId: string): Promise<T> {
  return request<T>('/api/run/start', jsonRequest('POST', { subject, topic_id: topicId }));
}

function postTopic<T>(url: string, topicId: string): Promise<T> {
  return request<T>(url, jsonRequest('POST', { topic_id: topicId }));
}

export const browserHomeApi: HomeApi = {
  plan: () => request<DayPlanResponse>('/api/run/plan'),
  profile: () => request<ProfileSummary>('/api/profile'),
  start: (subject, topicId) => postPlannedRun<StartRunResponse>(subject, topicId),
  startBoss: (topicId) => postTopic<StartBossResponse>('/api/boss/start', topicId),
  startTriage: (subject) => postSubject<StartRunResponse>('/api/triage/start', subject),
  finish: (runId) => request<FinishRunApiResponse>(`/api/run/${runId}/finish`, jsonRequest('POST')),
};
