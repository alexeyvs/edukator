import { vi } from 'vitest';
import type { AuthApi } from './auth-api';

/**
 * Заглушка входа для экранных тестов — одна на все четыре экрана, которые его
 * зовут (вход, приглашение, детская ссылка, состав семьи).
 *
 * Своя копия в каждом файле разъезжается с остальными молча: новый метод
 * контракта ломает четыре установки сразу, и правится это дописыванием четырёх
 * одинаковых строк — то есть до первого раза, когда кто-нибудь допишет три из
 * четырёх. Та же беда уже случалась с тройкой входа оператора в маршрутных
 * тестах админки и так же была сведена к общему помощнику.
 */
export function testAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    login: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    logout: vi.fn().mockResolvedValue(undefined),
    readInvite: vi.fn().mockResolvedValue({ email: 'parent@example.org' }),
    redeemInvite: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    claimDevice: vi.fn().mockResolvedValue({ kind: 'child', childId: 'c-1' }),
    switchPersona: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    changePassword: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    ...overrides,
  };
}
