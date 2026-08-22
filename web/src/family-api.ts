import { jsonRequest, requestJson } from './http';

export type ChildStatus = 'provisioning' | 'ready' | 'failed';

export type DeviceKind = 'browser' | 'agent';

export interface FamilyDevice {
  id: number;
  childId: string;
  kind: DeviceKind;
  label: string;
  inviteExpiresAt: string;
  claimedAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface FamilyChild {
  id: string;
  parentId: string;
  name: string;
  status: ChildStatus;
  lastActivityAt?: string;
  retiredAt?: string;
  createdAt: string;
  devices: FamilyDevice[];
  courses: FamilyCourseAssignment[];
}

export interface FamilyCourseAssignment {
  courseId: string;
  excludedTopicIds: string[];
  assignedAt?: string;
  unassignedAt?: string;
  updatedAt?: string;
}

export interface FamilyCourse {
  courseId: string;
  title: string;
  grade: string;
  revisionId: number;
  topics: Array<{ id: string; title: string; prereqs: string[] }>;
}

export interface Family {
  email: string;
  pinConfigured: boolean;
  children: FamilyChild[];
}

/**
 * Выпущенное приглашение. Сервер отдаёт путь, а не целый адрес: за прокси ему
 * неизвестны ни схема, ни внешнее имя. Целый адрес собирает клиент — он по
 * этому адресу и пришёл.
 */
export interface IssuedInvite {
  device: FamilyDevice;
  invite: { token: string; expiresAt: string; path: string };
}

export interface FamilyApi {
  read(): Promise<Family>;
  readCourses(): Promise<FamilyCourse[]>;
  addChild(name: string): Promise<FamilyChild>;
  retryProvision(childId: string): Promise<FamilyChild>;
  issueDevice(childId: string, kind: DeviceKind, label: string): Promise<IssuedInvite>;
  revokeDevice(deviceId: number): Promise<{ revoked: boolean; device: FamilyDevice }>;
  setPin(pin: string): Promise<{ pinConfigured: boolean }>;
  assignCourse(childId: string, courseId: string, excludedTopicIds?: string[]): Promise<FamilyCourseAssignment>;
  unassignCourse(childId: string, courseId: string): Promise<FamilyCourseAssignment | null>;
}

export const browserFamilyApi: FamilyApi = {
  read: () => requestJson<Family>('/api/family', undefined, 'Не получилось загрузить семью'),
  readCourses: async () => {
    const result = await requestJson<{ courses: FamilyCourse[] }>(
      '/api/family/courses', undefined, 'Не получилось загрузить каталог курсов',
    );
    return result.courses;
  },
  addChild: async (name) => {
    const created = await requestJson<{ child: FamilyChild }>(
      '/api/family/children',
      jsonRequest('POST', { name }),
      'Не получилось завести ребёнка',
    );
    return created.child;
  },
  retryProvision: async (childId) => {
    const provisioned = await requestJson<{ child: FamilyChild }>(
      `/api/family/children/${encodeURIComponent(childId)}/provision`,
      jsonRequest('POST'),
      'Не получилось завести базу ребёнка',
    );
    return provisioned.child;
  },
  issueDevice: (childId, kind, label) => requestJson<IssuedInvite>(
    `/api/family/children/${encodeURIComponent(childId)}/devices`,
    jsonRequest('POST', { kind, label }),
    'Не получилось выпустить ссылку',
  ),
  revokeDevice: (deviceId) => requestJson<{ revoked: boolean; device: FamilyDevice }>(
    `/api/family/devices/${String(deviceId)}/revoke`,
    jsonRequest('POST'),
    'Не получилось отозвать устройство',
  ),
  setPin: (pin) => requestJson<{ pinConfigured: boolean }>(
    '/api/family/pin',
    jsonRequest('POST', { pin }),
    'Не получилось сохранить PIN',
  ),
  assignCourse: async (childId, courseId, excludedTopicIds) => {
    const result = await requestJson<{ assignment: FamilyCourseAssignment }>(
      `/api/family/children/${encodeURIComponent(childId)}/courses/${encodeURIComponent(courseId)}`,
      jsonRequest('PUT', excludedTopicIds === undefined ? {} : { excludedTopicIds }),
      'Не получилось сохранить курс',
    );
    return result.assignment;
  },
  unassignCourse: async (childId, courseId) => {
    const result = await requestJson<{ assignment: FamilyCourseAssignment | null }>(
      `/api/family/children/${encodeURIComponent(childId)}/courses/${encodeURIComponent(courseId)}`,
      jsonRequest('DELETE'),
      'Не получилось снять курс',
    );
    return result.assignment;
  },
};
