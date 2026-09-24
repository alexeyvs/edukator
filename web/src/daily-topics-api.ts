import { jsonRequest, requestJson } from './http';

export interface DailyTopicInput {
  title: string;
  subjectId: string | null;
  subjectTitle: string;
  topicId: string | null;
}

export interface DailyTopicItem {
  id: number;
  position: number;
  topicId: string;
  subject: string;
  subjectTitle: string;
  courseRevisionId: number | null;
  title: string;
  materialId: number | null;
  status: 'preparing' | 'ready' | 'error';
  materialStatus: string | null;
  lastError: string | null;
  firstScore: number | null;
  firstTotal: number | null;
  firstRunId: number | null;
}

export interface DailyTopicSet {
  id: number;
  day: string;
  status: 'preparing' | 'active' | 'cancelled';
  sourceText: string;
  items: DailyTopicItem[];
}

export interface DailyTopicState {
  active: DailyTopicSet | null;
  preparing: DailyTopicSet | null;
}

export interface DailyTopicsApi {
  read(childId: string): Promise<DailyTopicState>;
  preview(childId: string, text: string): Promise<DailyTopicInput[]>;
  confirm(childId: string, sourceText: string, requestKey: string, items: DailyTopicInput[]): Promise<DailyTopicSet>;
  retry(childId: string): Promise<DailyTopicState>;
  cancel(childId: string): Promise<DailyTopicState>;
}

const path = (childId: string): string =>
  `/api/family/children/${encodeURIComponent(childId)}/daily-topics`;

export const browserDailyTopicsApi: DailyTopicsApi = {
  read: (childId) => requestJson<DailyTopicState>(path(childId), undefined, 'Не получилось загрузить темы на день'),
  preview: async (childId, text) => {
    const result = await requestJson<{ items: DailyTopicInput[] }>(
      `${path(childId)}/preview`, jsonRequest('POST', { text }), 'Не получилось разобрать список тем',
    );
    return result.items;
  },
  confirm: async (childId, sourceText, requestKey, items) => {
    const result = await requestJson<{ set: DailyTopicSet }>(
      path(childId), jsonRequest('PUT', { sourceText, requestKey, items }),
      'Не получилось назначить темы',
    );
    return result.set;
  },
  retry: (childId) => requestJson<DailyTopicState>(
    `${path(childId)}/retry`, jsonRequest('POST'), 'Не получилось повторить подготовку',
  ),
  cancel: (childId) => requestJson<DailyTopicState>(
    path(childId), jsonRequest('DELETE'), 'Не получилось отменить темы на день',
  ),
};
