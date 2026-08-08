export interface Profile {
  name: string;
  interests: string[];
  examDate: string | null;
  partnerName: string;
  introduction: string;
}

export interface ProfilePatch {
  name: string;
  interests: string[];
  examDate: string | null;
  partnerName: string;
}

export interface ProfileApi {
  read(): Promise<Profile>;
  save(profile: ProfilePatch): Promise<Profile>;
}

export const browserProfileApi: ProfileApi = {
  read: () => requestJson<Profile>('/api/profile', undefined, 'Не получилось сохранить профиль'),
  save: (profile) => requestJson<Profile>('/api/profile', jsonRequest('PUT', profile), 'Не получилось сохранить профиль'),
};
import { jsonRequest, requestJson } from './http';
