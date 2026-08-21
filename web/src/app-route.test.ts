import { describe, expect, it } from 'vitest';
import { appRoute, isAdminPath, readLinkPage } from './app-route';
import type { AuthState, Impersonation } from './auth-api';

const IMPERSONATION: Impersonation = {
  adminEmail: 'оператор@example.com',
  childName: 'Тимофей',
  role: 'browser',
  expiresAt: '2999-01-01T00:00:00.000Z',
};

const BOTH: AuthState = {
  kind: 'both',
  active: 'parent',
  parent: { email: 'parent@example.org' },
  child: { childId: 'c-1', name: 'Тимофей' },
};

describe('разбор страницы по ссылке', () => {
  it('узнаёт приглашение и погашение, но не пустой и не составной токен', () => {
    expect(readLinkPage('/invite/abc')).toEqual({ kind: 'invite', token: 'abc' });
    expect(readLinkPage('/join/abc')).toEqual({ kind: 'join', token: 'abc' });
    expect(readLinkPage('/join/')).toBeNull();
    expect(readLinkPage('/join/a/b')).toBeNull();
    expect(readLinkPage('/parents')).toBeNull();
  });

  it('не падает на битой процентной последовательности', () => {
    // `decodeURIComponent('%')` бросает `URIError`, а разбор зовётся из
    // инициализатора состояния: вылет там — белый экран без единого слова.
    expect(readLinkPage('/join/%')).toBeNull();
    expect(readLinkPage('/invite/%zz')).toBeNull();
  });
});

describe('адрес админки', () => {
  it('узнаёт её корень и карточку ребёнка, но не чужой адрес с тем же началом', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/child/c-1')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
    expect(isAdminPath('/parents')).toBe(false);
  });
});

describe('выбор состояния корня приложения', () => {
  it('рисует страницу по ссылке раньше всего остального', () => {
    // Ссылка гасится один раз: уступив её живой сессии, приложение потеряло бы
    // приглашение навсегда. Адрес к этому моменту уже подменён на `/`.
    expect(appRoute({
      link: { kind: 'invite', token: 'abc' },
      pathname: '/',
      principal: { kind: 'parent', email: 'parent@example.org' },
    })).toEqual({ kind: 'link', page: { kind: 'invite', token: 'abc' } });
  });

  it('ждёт ответа `me`, а не показывает вход, пока предъявитель неизвестен', () => {
    expect(appRoute({ link: null, pathname: '/', principal: null }))
      .toEqual({ kind: 'pending' });
  });

  it('показывает вход, когда никто не вошёл', () => {
    expect(appRoute({ link: null, pathname: '/', principal: { kind: 'anonymous' } }))
      .toEqual({ kind: 'login' });
  });

  it('называет родителя его адресом и без второй сессии', () => {
    expect(appRoute({
      link: null,
      pathname: '/',
      principal: { kind: 'parent', email: 'parent@example.org' },
    })).toEqual({ kind: 'parent', email: 'parent@example.org' });
  });

  it('называет ученика его номером и именем', () => {
    expect(appRoute({
      link: null,
      pathname: '/',
      principal: { kind: 'child', childId: 'c-1', name: 'Тимофей' },
    })).toEqual({ kind: 'child', childId: 'c-1', name: 'Тимофей', parents: false });
  });

  it('открывает сводку ученику по адресу `/parents`, а не по cookie', () => {
    expect(appRoute({
      link: null,
      pathname: '/parents',
      principal: { kind: 'child', childId: 'c-1', name: 'Тимофей' },
    })).toEqual({ kind: 'child', childId: 'c-1', name: 'Тимофей', parents: true });
  });

  it('называет агентский токен отдельным состоянием, а не учеником', () => {
    expect(appRoute({
      link: null,
      pathname: '/',
      principal: { kind: 'agent', childId: 'c-1' },
    })).toEqual({ kind: 'agent' });
  });

  it('при двух живых сессиях называет вторую по активной роли', () => {
    expect(appRoute({ link: null, pathname: '/', principal: BOTH }))
      .toEqual({
        kind: 'parent',
        email: 'parent@example.org',
        child: { childId: 'c-1', name: 'Тимофей' },
      });
    expect(appRoute({ link: null, pathname: '/parents', principal: { ...BOTH, active: 'child' } }))
      .toEqual({
        kind: 'child',
        childId: 'c-1',
        name: 'Тимофей',
        parents: true,
        parent: { email: 'parent@example.org' },
      });
  });

  it('доносит заход оператора до экранов семьи, а не подменяет их', () => {
    expect(appRoute({
      link: null,
      pathname: '/',
      principal: { kind: 'child', childId: 'c-1', name: 'Тимофей', impersonation: IMPERSONATION },
    })).toEqual({
      kind: 'child', childId: 'c-1', name: 'Тимофей', parents: false, impersonation: IMPERSONATION,
    });
    expect(appRoute({
      link: null,
      pathname: '/',
      principal: { kind: 'parent', email: 'чужой@example.org', impersonation: IMPERSONATION },
    })).toEqual({ kind: 'parent', email: 'чужой@example.org', impersonation: IMPERSONATION });
  });

  it('отдаёт админку её адресу, не спрашивая предъявителя', () => {
    expect(appRoute({ link: null, pathname: '/admin', principal: null }))
      .toEqual({ kind: 'admin' });
    expect(appRoute({ link: null, pathname: '/admin/child/c-1', principal: { kind: 'anonymous' } }))
      .toEqual({ kind: 'admin' });
  });

  it('оставляет админку оператору и под заходом: из него надо уметь выйти', () => {
    // Под заходом `me` возвращает предъявителя чужой семьи. Выиграй он у
    // адреса, админка отказывала бы ровно тогда, когда оператор в имперсонации.
    expect(appRoute({
      link: null,
      pathname: '/admin',
      principal: { kind: 'child', childId: 'c-1', name: 'Тимофей', impersonation: IMPERSONATION },
    })).toEqual({ kind: 'admin' });
  });

  it('уступает админку только странице по ссылке', () => {
    expect(appRoute({
      link: { kind: 'join', token: 'abc' },
      pathname: '/admin',
      principal: null,
    })).toEqual({ kind: 'link', page: { kind: 'join', token: 'abc' } });
  });
});
