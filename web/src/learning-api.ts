import type { Subject } from './home-api';
import type { FinishRunResponse, RunProgress } from './run-api';
import { jsonRequest, requestJson } from './http';

export type LearningBlockType = 'paragraph' | 'formula' | 'example' | 'warning';

export interface LearningBlock {
  type: LearningBlockType;
  content: string;
}

export interface LearningMaterialContent {
  introduction: string;
  objectives: string[];
  sections: Array<{ title: string; blocks: LearningBlock[] }>;
  summary: string[];
}

export interface LearningMaterialView {
  id: number;
  subject: Subject;
  topic: { id: string; title: string };
  recommendationReason: string;
  estimatedMinutes: number;
  status: 'ready' | 'active';
  content: LearningMaterialContent;
  progress: RunProgress;
  passScore: number;
}

export interface OpenLearningResponse {
  materialId: number;
  resumed: boolean;
  material: LearningMaterialView;
}

export interface StartLearningTestResponse {
  materialId: number;
  runId: number;
  resumed: boolean;
  progress: RunProgress;
}

export interface FinishLearningResponse extends FinishRunResponse {
  materialId: number;
  outcome: 'passed' | 'failed';
  masteryBefore: number;
  masteryAfter: number;
  passScore: number;
}

export interface LearningApi {
  read(materialId: number): Promise<LearningMaterialView>;
  open(materialId: number): Promise<OpenLearningResponse>;
  startTest(materialId: number): Promise<StartLearningTestResponse>;
  finish(runId: number): Promise<FinishLearningResponse>;
}

const request = <T>(url: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(url, init, 'Не получилось загрузить учебный материал');

export const browserLearningApi: LearningApi = {
  read: (materialId) => request<LearningMaterialView>(`/api/learning/${materialId}`),
  open: (materialId) => request<OpenLearningResponse>(
    `/api/learning/${materialId}/open`,
    jsonRequest('POST'),
  ),
  startTest: (materialId) => request<StartLearningTestResponse>(
    `/api/learning/${materialId}/test`,
    jsonRequest('POST'),
  ),
  finish: (runId) => request<FinishLearningResponse>(
    `/api/learning/run/${runId}/finish`,
    jsonRequest('POST'),
  ),
};
