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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null &&
      typeof (body as Record<string, unknown>)['error'] === 'string'
      ? (body as Record<string, string>)['error']
      : 'Не получилось сохранить профиль';
    throw new Error(message);
  }
  return body as T;
}

export const browserProfileApi: ProfileApi = {
  read: () => request<Profile>('/api/profile'),
  save: (profile) => request<Profile>('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  }),
};
