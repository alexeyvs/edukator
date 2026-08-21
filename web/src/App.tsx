import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { BrandLink } from './BrandMark';
import { AdminApp } from './admin/AdminApp';
import { ImpersonationBanner } from './admin/ImpersonationBanner';
import { appRoute, isAdminPath, readLinkPage, type LinkPage } from './app-route';
import { browserAuthApi, type AuthApi, type AuthState } from './auth-api';
import { onSignedOut, SignedOutError } from './http';
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
  // Попытка чтения профиля: эффект сам не повторится (профиль так и остаётся
  // `null`), и без кнопки обрыв сети запирал бы ученика на сообщении.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api.read()
      .then((loaded) => { if (active) setProfile(loaded); })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить профиль');
      });
    return () => { active = false; };
  }, [api, attempt]);

  if (problem !== null) {
    return (
      <main className="run-state">
        <p className="home-error" role="alert">{problem}</p>
        <button
          type="button"
          onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
        >
          Повторить
        </button>
      </main>
    );
  }
  if (profile === null) {
    return (
      <main className="run-state" role="status">
        <BrandLink />
        <p>Проверяю профиль…</p>
      </main>
    );
  }
  if (profile.partnerName.trim().length === 0) {
    return <ProfileScreen api={api} initialProfile={profile} onboarding onSaved={setProfile} />;
  }
  return children;
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
  const [principal, setPrincipal] = useState<AuthState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Счётчик попыток проверить вход. Он и есть кнопка «Повторить»: эффект второй
  // раз сам не пойдёт (предъявитель остаётся `null`), и без него обрыв сети на
  // старте оставлял бы «Failed to fetch» насовсем — в том числе ребёнку, только
  // что погасившему свою одноразовую ссылку.
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [logoutProblem, setLogoutProblem] = useState<string | null>(null);
  const [personaPassword, setPersonaPassword] = useState('');
  const [personaProblem, setPersonaProblem] = useState<string | null>(null);
  const [personaPending, setPersonaPending] = useState(false);
  const [parentSwitchOpen, setParentSwitchOpen] = useState(false);
  /**
   * Только что состоялось действие, после которого предъявитель обязан
   * появиться: вход родителя или погашение ссылки.
   *
   * Нужен потому, что удавшееся действие входом ещё не делает. Cookie несут
   * префикс `__Host-`, а его браузер принимает только с `Secure`, то есть по
   * HTTPS или с `localhost`: по голому http на адрес вида `192.168.100.141:3000`
   * сервер отвечает 200, ссылка гасится безвозвратно, а cookie молча выбрасывает
   * браузер. Без этой отметки `me` возвращает `anonymous`, и ребёнок получает
   * форму родительского входа без единого слова о причине — с ссылкой, которой
   * больше нет.
   */
  const signInExpected = useRef(false);
  // Кем был предъявитель до того, как сессия кончилась: слушатель `onSignedOut`
  // ставится один раз и до самого предъявителя не дотягивается. Нужно всё
  // состояние, а не только `kind`: для `both` важно, чья именно сессия
  // отказала и есть ли вторая, которую можно перечитать у `me`.
  const lastPrincipal = useRef<AuthState | undefined>(undefined);
  useEffect(() => {
    if (principal !== null) lastPrincipal.current = principal;
  }, [principal]);

  // Токен уходит из адресной строки сразу после загрузки: адрес попадает в
  // историю браузера, в заголовок вкладки и в `Referer` на любой внешней
  // ссылке, а сам он и есть весь секрет.
  useEffect(() => {
    if (link === null) return;
    window.history.replaceState(null, '', '/');
  }, [link]);

  // Сессия кончается посреди любого экрана: решение показать вход принимается
  // здесь, а не в каждом экране отдельно.
  //
  // Текст зависит от того, кого выбросило. «Войдите заново» над формой с адресом
  // и паролем — совет родителю; ученику, чьё устройство отозвали, тот же экран
  // предлагает сделать невозможное: пароля у него нет и быть не должно, вернуть
  // его может только новая ссылка от родителя.
  useEffect(() => onSignedOut(() => {
    const previous = lastPrincipal.current;
    const activeKind = previous?.kind === 'both' ? previous.active : previous?.kind;
    setNotice(
      activeKind === 'child' || activeKind === 'agent'
        ? 'Это устройство отключено. Попросите родителя выпустить новую ссылку.'
        : 'Сессия закончилась. Войдите заново.',
    );
    // Один 401 говорит только об активном предъявителе. Если в браузере были
    // обе сессии, `me` должен выбрать уцелевшую; немедленный `anonymous`
    // отменял и её вместе с протухшей.
    setPrincipal(previous?.kind === 'both' ? null : { kind: 'anonymous' });
  }), []);

  useEffect(() => {
    // Админка не спрашивает `me` вовсе: у оператора нет ни детской, ни
    // родительской сессии, а под заходом ответ пришёл бы от чужой семьи —
    // предъявителя админских маршрутов он не называет ни в одном случае.
    if (link !== null || principal !== null || isAdminPath(window.location.pathname)) return;
    let active = true;
    authApi.me()
      .then((who) => {
        if (!active) return;
        if (who.kind === 'anonymous' && signInExpected.current) {
          setNotice(
            'Вход состоялся, но браузер не принял cookie: их имя требует HTTPS. '
            + 'Откройте приложение по HTTPS либо с той же машины по localhost — '
            + 'и попросите родителя выпустить ссылку заново.',
          );
        }
        signInExpected.current = false;
        setPrincipal(who);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // 401 на `me` — не поломка, а «войдите». Показанный ошибкой, он встал бы
        // навсегда: `problem` проверяется раньше `anonymous`, а эффект второй раз
        // не пойдёт — предъявитель уже не `null`. Предъявитель ставится здесь же,
        // а не только слушателем `onSignedOut`: у `me` нет экрана, который надо
        // сохранить, и ждать чужого побочного действия ради собственного
        // состояния значило бы зависнуть на «Проверяю вход…», если его не будет.
        if (error instanceof SignedOutError) {
          setPrincipal({ kind: 'anonymous' });
          return;
        }
        setProblem(error instanceof Error ? error.message : 'Не получилось проверить вход');
      });
    return () => { active = false; };
  }, [authApi, link, principal, attempt]);

  // После погашения любой ссылки предъявитель перечитывается, а не берётся из
  // ответа. У браузера ребёнка имя и номер знает только `me`; у родителя ответ
  // на установку пароля вообще может разойтись с сервером — ссылку открывают и
  // на детской машине, а при двух живых cookie `me` возвращает обе сессии и
  // сохранённый выбор роли.
  const finishLink = useCallback(() => {
    signInExpected.current = true;
    setPrincipal(null);
    setLink(null);
  }, []);

  const logout = useCallback(() => {
    setLogoutProblem(null);
    void authApi.logout()
      .then(() => {
        setPrincipal(principal?.kind === 'both'
          ? { kind: 'child', childId: principal.child.childId, name: principal.child.name }
          : { kind: 'anonymous' });
        setNotice(undefined);
      })
      .catch((error: unknown) => {
        // Cookie родителя `HttpOnly`: при обрыве снять её клиент не может.
        // Поэтому экран входа до подтверждённого ответа сервера был бы ложным:
        // перезагрузка сразу вернёт живую родительскую сессию.
        setLogoutProblem(error instanceof Error ? error.message : 'Не получилось выйти');
      });
  }, [authApi, principal]);

  const switchToChild = useCallback(() => {
    void authApi.switchPersona('child')
      .then(setPrincipal)
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : 'Не получилось переключить пользователя');
      });
  }, [authApi]);

  const switchToParent = useCallback(() => {
    if (personaPending || personaPassword.length === 0) return;
    setPersonaPending(true);
    setPersonaProblem(null);
    void authApi.switchPersona('parent', personaPassword)
      .then((next) => {
        setPrincipal(next);
        setPersonaPassword('');
        setParentSwitchOpen(false);
      })
      .catch((error: unknown) => {
        setPersonaPassword('');
        setPersonaProblem(error instanceof Error ? error.message : 'Не получилось подтвердить родителя');
      })
      .finally(() => setPersonaPending(false));
  }, [authApi, personaPassword, personaPending]);

  const route = appRoute({ link, pathname: window.location.pathname, principal });

  if (route.kind === 'link') {
    return route.page.kind === 'invite'
      ? <InviteScreen api={authApi} token={route.page.token} onSignedIn={finishLink} />
      : <JoinScreen api={authApi} token={route.page.token} onClaimed={finishLink} />;
  }

  // Админка идёт до поломки проверки входа: `me` на её адресе не спрашивают
  // вовсе, и чужая ошибка сети заслоняла бы оператору его единственный экран.
  if (route.kind === 'admin') return <AdminApp />;

  if (problem !== null) {
    return (
      <main className="run-state">
        <p className="home-error" role="alert">{problem}</p>
        <button
          type="button"
          onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
        >
          Повторить
        </button>
      </main>
    );
  }

  if (route.kind === 'pending') {
    return (
      <main className="run-state" role="status">
        <BrandLink />
        <p>Проверяю вход…</p>
      </main>
    );
  }

  if (route.kind === 'login') {
    // Предъявитель перечитывается, а не берётся из ответа входа, ровно по той
    // же причине, что и после погашения ссылки: вход родителя на детской машине
    // отвечает `parent`, а `me` обязан вернуть обе живые сессии и активную роль.
    return (
      <LoginScreen
        api={authApi}
        {...(notice === undefined ? {} : { notice })}
        onSignedIn={() => { signInExpected.current = true; setPrincipal(null); }}
      />
    );
  }

  // Агентский токен в браузере — не рабочее состояние: он выдаётся контроллеру
  // доступа, у которого никакого интерфейса нет.
  if (route.kind === 'agent') {
    return (
      <main className="run-state">
        <p className="home-error" role="alert">Это устройство подключено как контроллер доступа, а не как компьютер ученика.</p>
      </main>
    );
  }

  // Полоса захода рисуется поверх настоящих экранов семьи, а не вместо них:
  // оператор пришёл смотреть ровно то, что видит семья, и подменённый экран
  // отвечал бы не на тот вопрос.
  const banner = route.impersonation !== undefined
    ? <ImpersonationBanner impersonation={route.impersonation} />
    : null;

  if (route.kind === 'parent') {
    return <>
      {banner}
      {logoutProblem !== null && (
        <div className="auth-message error" role="alert">
          <p>{logoutProblem}</p>
          <button type="button" onClick={logout}>Повторить выход</button>
        </div>
      )}
      {route.child !== undefined && (
        <button type="button" onClick={switchToChild}>
          Перейти к ученику {route.child.name}
        </button>
      )}
      <ParentArea email={route.email} onLogout={logout} />
    </>;
  }

  const childSwitcher = route.parent !== undefined ? (
    parentSwitchOpen ? (
      <form className="auth-card" onSubmit={(event) => { event.preventDefault(); switchToParent(); }}>
        <label className="auth-field">
          <span>Пароль родителя</span>
          <input
            autoComplete="current-password"
            name="parent-password"
            required
            type="password"
            value={personaPassword}
            onChange={(event) => setPersonaPassword(event.target.value)}
          />
        </label>
        {personaProblem !== null && <p className="auth-message error" role="alert">{personaProblem}</p>}
        <button className="auth-submit" disabled={personaPending} type="submit">
          {personaPending ? 'Проверяю…' : 'Подтвердить вход родителя'}
        </button>
        <button type="button" onClick={() => { setParentSwitchOpen(false); setPersonaProblem(null); }}>
          Отмена
        </button>
      </form>
    ) : (
      <button type="button" onClick={() => setParentSwitchOpen(true)}>Перейти к родителю</button>
    )
  ) : null;

  // Ребёнок назван в адресе сводки и у самого ученика: его номер приходит из
  // `me`, а не подразумевается по cookie.
  if (route.parents) {
    return <>{banner}{childSwitcher}<ParentsScreen childId={route.childId} /></>;
  }
  return <>{banner}{childSwitcher}<ChildArea /></>;
}
