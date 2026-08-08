// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileGate } from './App';
import { ProfileScreen } from './ProfileScreen';
import type { Profile, ProfileApi } from './profile-api';
import './test-setup';

afterEach(cleanup);

const EMPTY_PROFILE: Profile = {
  name: '',
  interests: [],
  examDate: null,
  partnerName: '',
  introduction: 'Я твой напарник. Меня можно переименовать.',
};

function profileApi(profile: Profile = EMPTY_PROFILE): ProfileApi {
  return {
    read: vi.fn().mockResolvedValue(profile),
    save: vi.fn().mockImplementation(async (patch) => ({
      ...profile,
      ...patch,
    })),
  };
}

describe('знакомство и профиль', () => {
  it('показывает знакомство до имени напарника и уводит его после заполнения профиля', async () => {
    const api = profileApi();
    render(<ProfileGate api={api}><p>План дня открыт</p></ProfileGate>);

    expect(await screen.findByRole('heading', { name: 'Сначала познакомимся' })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_PROFILE.introduction)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Как тебя зовут'), { target: { value: 'Тимофей' } });
    fireEvent.change(screen.getByLabelText('Как назвать напарника'), { target: { value: 'Кекс' } });
    fireEvent.change(screen.getByLabelText('Что тебе интересно'), { target: { value: 'скейт, Minecraft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Познакомились. К плану' }));

    expect(await screen.findByText('План дня открыт')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Сначала познакомимся' })).not.toBeInTheDocument();
    expect(api.save).toHaveBeenCalledWith({
      name: 'Тимофей',
      partnerName: 'Кекс',
      interests: ['скейт', 'Minecraft'],
      examDate: null,
    });
  });

  it('не сохраняет пустое имя и показывает отказ сервера', async () => {
    const api = profileApi({ ...EMPTY_PROFILE, partnerName: 'Кекс' });
    vi.mocked(api.save).mockRejectedValue(new Error('Профиль временно недоступен'));
    render(<ProfileScreen api={api} initialProfile={{ ...EMPTY_PROFILE, partnerName: 'Кекс' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    expect(screen.getByRole('alert')).toHaveTextContent('пустое имя сохранить нельзя');
    expect(api.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Как тебя зовут'), { target: { value: 'Тимофей' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Профиль временно недоступен'));
    expect(screen.getByRole('button', { name: 'Сохранить изменения' })).toBeEnabled();
  });

  it('показывает отказ начальной загрузки как ошибку', async () => {
    const api = profileApi();
    vi.mocked(api.read).mockRejectedValue(new Error('Профиль временно недоступен'));
    render(<ProfileScreen api={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Профиль временно недоступен');
  });
});
