// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';
import type { AuthApi } from './auth-api';
import './test-setup';

afterEach(cleanup);

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    login: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    logout: vi.fn().mockResolvedValue(undefined),
    readInvite: vi.fn().mockResolvedValue({ email: 'parent@example.org' }),
    redeemInvite: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    claimDevice: vi.fn().mockResolvedValue({ kind: 'child', childId: 'c-1' }),
    ...overrides,
  };
}

describe('погашение детской ссылки', () => {
  it('гасит ссылку сразу и отдаёт управление наверх', async () => {
    const api = authApi();
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    await waitFor(() => expect(onClaimed).toHaveBeenCalledOnce());
    expect(api.claimDevice).toHaveBeenCalledWith('tok');
  });

  it('показывает токен агента один раз и не пускает его на занятие', async () => {
    const api = authApi({
      claimDevice: vi.fn().mockResolvedValue({ kind: 'agent', childId: 'c-1', token: 'agent-token' }),
    });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    expect(await screen.findByText('agent-token')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Токен агента' })).toBeInTheDocument();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('объясняет протухшую или отозванную ссылку и не оставляет ученика в загрузке', async () => {
    const api = authApi({
      claimDevice: vi.fn().mockRejectedValue(new Error('Ссылка недействительна или уже использована')),
    });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ссылка недействительна или уже использована');
    expect(screen.queryByText('Подключаю устройство…')).not.toBeInTheDocument();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('не гасит одноразовую ссылку дважды при повторном запуске эффекта', async () => {
    const api = authApi();
    const onClaimed = vi.fn();
    const { rerender } = render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);
    rerender(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    await waitFor(() => expect(onClaimed).toHaveBeenCalled());
    expect(api.claimDevice).toHaveBeenCalledOnce();
  });
});
