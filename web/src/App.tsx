import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HomeScreen } from './HomeScreen';
import { ParentsScreen } from './ParentsScreen';
import { BossScreen } from './BossScreen';
import { ProfileScreen } from './ProfileScreen';
import { RunScreen } from './RunScreen';
import { TriageScreen } from './TriageScreen';
import { LearningScreen } from './LearningScreen';
import { FamilyScreen } from './FamilyScreen';
import { InviteScreen } from './InviteScreen';
import { JoinScreen } from './JoinScreen';
import { LoginScreen } from './LoginScreen';
import { browserAuthApi, type AuthApi, type Principal } from './auth-api';
import { onSignedOut } from './http';
import { browserProfileApi, type Profile, type ProfileApi } from './profile-api';

export function ProfileGate({
  api = browserProfileApi,
  children,
}: {
  api?: ProfileApi;
  children: ReactNode;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.read()
      .then((loaded) => { if (active) setProfile(loaded); })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить профиль');
      });
    return () => { active = false; };
  }, [api]);

  if (problem !== null) {
    return <main className="run-state"><p className="home-error" role="alert">{problem}</p></main>;
  }
  if (profile === null) {
    return (
      <main className="run-state" role="status">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <p>Проверяю профиль…</p>
      </main>
    );
  }
  if (profile.partnerName.trim().length === 0) {
    return <ProfileScreen api={api} initialProfile={profile} onboarding onSaved={setProfile} />;
  }
  return children;
}

/** Страница по ссылке: приглашение родителя или погашение детского устройства. */
export interface LinkPage {
  kind: 'invite' | 'join';
  token: string;
}

const LINK_PREFIXES: ReadonlyArray<[string, LinkPage['kind']]> = [
  ['/invite/', 'invite'],
  ['/join/', 'join'],
];

/**
 * Токен из адреса страницы. Пустой и составной сегменты — не токен: сервер
 * такие страницы и не отдаёт, а разбирать их здесь значило бы носить по
 * приложению строку, которая ничего не открывает.
 */
export function readLinkPage(pathname: string): LinkPage | null {
  for (const [prefix, kind] of LINK_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    const token = decodeURIComponent(pathname.slice(prefix.length));
    if (token !== '' && !token.includes('/')) return { kind, token };
  }
  return null;
}

/** Занятие ученика: тот же разбор адреса, что и в однопользовательской версии. */
function ChildArea() {
  const params = new URLSearchParams(window.location.search);
  const runId = Number(params.get('runId'));
  const learningId = Number(params.get('learningId'));
  let screen: ReactNode;
  if (Number.isSafeInteger(runId) && runId > 0) {
    const kind = params.get('kind');
    screen = kind === 'triage'
      ? <TriageScreen runId={runId} />
      : kind === 'boss' ? <BossScreen runId={runId} />
        : kind === 'lesson' ? <RunScreen runId={runId} kind="lesson" />
          : <RunScreen runId={runId} />;
  } else if (Number.isSafeInteger(learningId) && learningId > 0) {
    screen = <LearningScreen materialId={learningId} />;
  } else if (params.get('screen') === 'profile') {
    screen = <ProfileScreen />;
  } else {
    screen = <HomeScreen />;
  }
  return <ProfileGate>{screen}</ProfileGate>;
}

/** Что видит вошедший родитель: состав семьи или сводка выбранного ребёнка. */
function ParentArea({
  email,
  onLogout,
}: {
  email: string;
  onLogout: () => void;
}) {
  const [dashboard, setDashboard] = useState<
    { childId: string; children: Array<{ id: string; name: string }> } | null
  >(null);

  if (dashboard === null) {
    return (
      <FamilyScreen
        email={email}
        onLogout={onLogout}
        onOpenDashboard={(childId, children) => setDashboard({ childId, children })}
      />
    );
  }
  return (
    <ParentsScreen
      childId={dashboard.childId}
      home={{ label: 'К составу семьи', onClick: () => setDashboard(null) }}
      pinRequired={false}
      siblings={dashboard.children}
      onSelectChild={(childId) => setDashboard({ ...dashboard, childId })}
    />
  );
}

export function App({ authApi = browserAuthApi }: { authApi?: AuthApi } = {}) {
  const [link, setLink] = useState<LinkPage | null>(() => readLinkPage(window.location.pathname));
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // Токен уходит из адресной строки сразу после загрузки: адрес попадает в
  // историю браузера, в заголовок вкладки и в `Referer` на любой внешней
  // ссылке, а сам он и есть весь секрет.
  useEffect(() => {
    if (link === null) return;
    window.history.replaceState(null, '', '/');
  }, [link]);

  // Сессия кончается посреди любого экрана: решение показать вход принимается
  // здесь, а не в каждом экране отдельно.
  useEffect(() => onSignedOut(() => {
    setPrincipal({ kind: 'anonymous' });
    setNotice('Сессия закончилась. Войдите заново.');
  }), []);

  useEffect(() => {
    if (link !== null || principal !== null) return;
    let active = true;
    authApi.me()
      .then((who) => { if (active) setPrincipal(who); })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось проверить вход');
      });
    return () => { active = false; };
  }, [authApi, link, principal]);

  // После погашения ссылки предъявитель перечитывается: у браузера ребёнка уже
  // есть cookie, а имя и номер ребёнка знает только `me`.
  const finishLink = useCallback(() => {
    setPrincipal(null);
    setLink(null);
  }, []);

  const logout = useCallback(() => {
    void authApi.logout().finally(() => {
      setPrincipal({ kind: 'anonymous' });
      setNotice(undefined);
    });
  }, [authApi]);

  if (link !== null) {
    return link.kind === 'invite'
      ? <InviteScreen api={authApi} token={link.token} onSignedIn={setPrincipal} />
      : <JoinScreen api={authApi} token={link.token} onClaimed={finishLink} />;
  }

  if (problem !== null) {
    return <main className="run-state"><p className="home-error" role="alert">{problem}</p></main>;
  }

  if (principal === null) {
    return (
      <main className="run-state" role="status">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <p>Проверяю вход…</p>
      </main>
    );
  }

  if (principal.kind === 'anonymous') {
    return <LoginScreen api={authApi} {...(notice === undefined ? {} : { notice })} onSignedIn={setPrincipal} />;
  }

  if (principal.kind === 'parent') {
    return <ParentArea email={principal.email} onLogout={logout} />;
  }

  // Агентский токен в браузере — не рабочее состояние: он выдаётся контроллеру
  // доступа, у которого никакого интерфейса нет.
  if (principal.kind === 'agent') {
    return (
      <main className="run-state">
        <p className="home-error" role="alert">Это устройство подключено как контроллер доступа, а не как компьютер ученика.</p>
      </main>
    );
  }

  // Ребёнок назван в адресе сводки и у самого ученика: его номер приходит из
  // `me`, а не подразумевается по cookie.
  if (window.location.pathname === '/parents') {
    return <ParentsScreen childId={principal.childId} />;
  }
  return <ChildArea />;
}
