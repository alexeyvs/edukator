// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FamilyScreen } from './FamilyScreen';
import type { Family, FamilyApi, FamilyChild } from './family-api';
import './test-setup';

afterEach(cleanup);

const CHILD: FamilyChild = {
  id: 'c-1',
  parentId: 'p-1',
  name: 'Тимофей',
  status: 'ready',
  createdAt: '2026-08-01T09:00:00.000Z',
  devices: [
    {
      id: 4,
      childId: 'c-1',
      kind: 'browser',
      label: 'Ноутбук',
      inviteExpiresAt: '2026-08-03T09:00:00.000Z',
      claimedAt: '2026-08-01T10:00:00.000Z',
      createdAt: '2026-08-01T09:00:00.000Z',
    },
    {
      id: 5,
      childId: 'c-1',
      kind: 'agent',
      label: 'Контроллер',
      inviteExpiresAt: '2026-08-03T09:00:00.000Z',
      revokedAt: '2026-08-02T10:00:00.000Z',
      createdAt: '2026-08-01T09:00:00.000Z',
    },
  ],
};

const FAMILY: Family = {
  email: 'parent@example.org',
  pinConfigured: true,
  children: [CHILD],
};

function familyApi(overrides: Partial<FamilyApi> = {}, value: Family = FAMILY): FamilyApi {
  return {
    read: vi.fn().mockResolvedValue(value),
    addChild: vi.fn().mockResolvedValue({ ...CHILD, id: 'c-2', name: 'Марта', devices: [] }),
    issueDevice: vi.fn().mockResolvedValue({
      device: { ...CHILD.devices[0], id: 6, label: 'Второй компьютер', claimedAt: undefined },
      invite: { token: 'tok', expiresAt: '2026-08-05T09:00:00.000Z', path: '/join/tok' },
    }),
    revokeDevice: vi.fn().mockResolvedValue({ revoked: true, device: CHILD.devices[0] }),
    setPin: vi.fn().mockResolvedValue({ pinConfigured: true }),
    ...overrides,
  };
}

function props(api: FamilyApi) {
  return {
    api,
    email: 'parent@example.org',
    onOpenDashboard: vi.fn(),
    onLogout: vi.fn(),
  };
}

describe('состав семьи', () => {
  it('показывает детей, состояние устройств и настроенный PIN', async () => {
    render(<FamilyScreen {...props(familyApi())} />);

    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });
    expect(child).toHaveTextContent('Готов к занятиям');
    expect(child).toHaveTextContent('Подключено');
    expect(child).toHaveTextContent('Отозвано');
    expect(within(child).getByRole('button', { name: 'Отозвано' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'PIN родителя' }))
      .toHaveTextContent('PIN настроен.');
  });

  it('выпускает ссылку и показывает целый адрес ровно один раз', async () => {
    const api = familyApi();
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(within(child).getByLabelText('Подпись'), { target: { value: 'Второй компьютер' } });
    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));

    expect(await screen.findByText(`${window.location.origin}/join/tok`)).toBeInTheDocument();
    expect(api.issueDevice).toHaveBeenCalledWith('c-1', 'browser', 'Второй компьютер');
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('показывает токен агента вместо ссылки: контроллеру нужен он, а не страница', async () => {
    const api = familyApi({
      issueDevice: vi.fn().mockResolvedValue({
        device: { ...CHILD.devices[1], id: 7, claimedAt: undefined, revokedAt: undefined },
        invite: { token: 'agent-token', expiresAt: '2026-08-05T09:00:00.000Z', path: '/join/agent-token' },
      }),
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(within(child).getByLabelText('Вид устройства'), { target: { value: 'agent' } });
    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));

    expect(await screen.findByText('agent-token')).toBeInTheDocument();
    expect(screen.queryByText(`${window.location.origin}/join/agent-token`)).not.toBeInTheDocument();
  });

  it('отзывает устройство и перечитывает состав семьи', async () => {
    const api = familyApi();
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Отозвать' }));

    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith(4));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('показывает отказ сервера на заведении ребёнка', async () => {
    const api = familyApi({
      addChild: vi.fn().mockRejectedValue(new Error('База ребёнка не заведена, попробуйте позже')),
    });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Имя ребёнка'), { target: { value: 'Марта' } });
    fireEvent.click(screen.getByRole('button', { name: 'Завести ребёнка' }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('База ребёнка не заведена, попробуйте позже');
  });

  it('не шлёт PIN, не похожий на PIN, и показывает отказ сервера', async () => {
    const api = familyApi({
      setPin: vi.fn().mockRejectedValue(new Error('PIN недоступен: серверный pepper не настроен')),
    });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    const pin = screen.getByLabelText('Новый PIN');
    fireEvent.change(pin, { target: { value: '123' } });
    expect(screen.getByRole('button', { name: 'Сохранить PIN' })).toBeDisabled();

    fireEvent.change(pin, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить PIN' }));
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('PIN недоступен: серверный pepper не настроен');
    expect(api.setPin).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('открывает сводку выбранного ребёнка вместе со списком остальных', async () => {
    const api = familyApi({}, {
      ...FAMILY,
      children: [CHILD, { ...CHILD, id: 'c-2', name: 'Марта', devices: [] }],
    });
    const screenProps = props(api);
    render(<FamilyScreen {...screenProps} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Марта' });

    fireEvent.click(within(child).getByRole('button', { name: 'Сводка' }));

    expect(screenProps.onOpenDashboard).toHaveBeenCalledWith('c-2', [
      { id: 'c-1', name: 'Тимофей' },
      { id: 'c-2', name: 'Марта' },
    ]);
  });

  it('не пускает в сводку и не даёт ссылку ребёнку без готовой базы', async () => {
    const api = familyApi({}, {
      ...FAMILY,
      children: [{ ...CHILD, status: 'provisioning', devices: [] }],
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    expect(child).toHaveTextContent('База заводится');
    expect(within(child).getByRole('button', { name: 'Сводка' })).toBeDisabled();
    expect(within(child).getByRole('button', { name: 'Выпустить ссылку' })).toBeDisabled();
  });

  it('показывает отказ чтения семьи вместо пустого состава', async () => {
    const api = familyApi({ read: vi.fn().mockRejectedValue(new Error('Управление семьёй недоступно')) });
    render(<FamilyScreen {...props(api)} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Управление семьёй недоступно');
  });
});
