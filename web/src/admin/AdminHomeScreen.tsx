import { useEffect, useState, type FormEvent } from 'react';
import {
  browserAdminApi,
  type AdminApi,
  type AdminChildStatus,
  type AdminFamily,
  type AdminFamilyChild,
  type AdminImpersonationRole,
  type AdminOverview,
  type AdminParentInvite,
} from '../admin-api';
import { HttpError } from '../http';
import { inviteUrl } from '../invite-url';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, isParentPassword } from '../password-format';

const STATUS_NAMES: Record<AdminChildStatus, string> = {
  provisioning: 'База заводится',
  ready: 'Готов к занятиям',
  failed: 'База не завелась',
};

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});

function when(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/**
 * Размер человеку. Мегабайты, а не байты: у оператора на экране тридцать баз
 * сразу, и различать их по девятизначным числам он не станет.
 */
export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Что рассказать про ребёнка одной строкой. «Ни разу» — отдельное состояние, а
 * не пустая дата: ребёнок, который так и не занимался, и ребёнок, занимавшийся
 * давно, — разные жалобы.
 */
export function childState(child: AdminFamilyChild): string {
  if (child.retiredAt !== undefined) return `Выведен ${when(child.retiredAt)}`;
  if (child.lastActivityAt === undefined) return 'Ни разу не занимался';
  return `Занимался ${when(child.lastActivityAt)}`;
}

function Numbers({ overview }: { overview: AdminOverview }) {
  const { parents, children, quota, sessions, devices, storage } = overview;
  return (
    <dl className="admin-numbers">
      <div>
        <dt>Родители</dt>
        <dd>{parents.total}</dd>
        <small>
          за 7 дней {parents.last7Days}, за 30 дней {parents.last30Days}, отключено {parents.disabled}
        </small>
      </div>
      <div>
        <dt>Дети</dt>
        <dd>{children.total}</dd>
        <small>
          готовы {children.ready}, заводятся {children.provisioning}, отказ {children.failed},
          выведено {children.retired}
        </small>
      </div>
      <div>
        <dt>Живые сессии</dt>
        <dd>{sessions.parents + sessions.admins}</dd>
        <small>родителей {sessions.parents}, операторов {sessions.admins}</small>
      </div>
      <div>
        <dt>Устройства</dt>
        <dd>{devices.browser + devices.agent}</dd>
        <small>
          компьютеров {devices.browser}, контроллеров {devices.agent},
          ссылок ждёт {devices.pendingInvites}
        </small>
      </div>
      <div>
        <dt>Квота codex</dt>
        <dd>{quota.used}</dd>
        {/* Предел — на одного ребёнка, а не на сервер: сумма выше него это не
            превышение, и подписать её «из N» значило бы соврать. */}
        <small>за {quota.day}, предел {quota.limit} на ребёнка</small>
      </div>
      <div>
        <dt>Место</dt>
        <dd>{megabytes(storage.totalBytes)}</dd>
        <small>
          управляющая {megabytes(storage.controlBytes)}, детские {megabytes(storage.childrenBytes)}
          {storage.freeBytes === undefined ? '' : `, свободно ${megabytes(storage.freeBytes)}`}
        </small>
      </div>
    </dl>
  );
}

/**
 * Похоже ли на электронную почту — та же грубая проверка, что и в серверном
 * `normalizeEmail`. Строгой её делать нечего: настоящую проверку адреса делает
 * сервер, а этой хватает, чтобы не слать заведомый 400 и не заводить у
 * оператора привычку читать отказы как поломку.
 */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  const parts = trimmed.split('@');
  return trimmed.length > 0
    && trimmed.length <= 254
    && parts.length === 2
    && parts.every((part) => part.length > 0)
    && !/\s/u.test(trimmed);
}

/**
 * Показанная ссылка на установку пароля. Видна ровно один раз: в базе лежит
 * отпечаток, и повторно показать её невозможно не по недосмотру, а по
 * устройству хранения. Поэтому ссылки **копятся**, а не сменяют друг друга —
 * вторая выпущенная убирала бы с экрана единственный экземпляр первой.
 */
function ParentInvite({ invite, email }: { invite: AdminParentInvite; email: string }) {
  return (
    <div className="admin-invite" role="status">
      <p>Ссылка для «{email}»</p>
      <code>{inviteUrl(invite.path)}</code>
      <small>
        Передайте её родителю: по ней он поставит пароль сам. Действует до{' '}
        {when(invite.expiresAt)}. Второй раз не покажется.
      </small>
    </div>
  );
}

/** Заведение семьи: адрес родителя и одноразовая ссылка ему на пароль. */
function NewFamily({ api, onCreated }: { api: AdminApi; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<Array<{ email: string; invite: AdminParentInvite }>>([]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (!looksLikeEmail(email)) {
      setProblem('Адрес не похож на электронную почту');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const created = await api.createFamily(email.trim());
      setIssued((shown) => [...shown, { email: created.parent.email, invite: created.invite }]);
      setEmail('');
    } catch (error: unknown) {
      // Набранное остаётся: «уже заведён» — повод посмотреть на адрес, а не
      // набирать его заново.
      setProblem(error instanceof Error ? error.message : 'Не получилось завести семью');
      setPending(false);
      return;
    }
    setPending(false);
    // Список семей перечитывается отдельно от заведения и своим отказом: семья
    // уже заведена, и неудача перечитывания не имеет права выглядеть неудачей
    // заведения — иначе очевидное действие «нажать ещё раз» упрётся в 409.
    onCreated();
  }

  return (
    <div className="admin-new-family">
      <form className="form-row" onSubmit={(event) => { void submit(event); }}>
        <label>
          <span>Адрес родителя</span>
          {/* `type="text"`, а не `type="email"`: браузер проверяет `email`
              ASCII-регуляркой из спеки и адрес с кириллицей до отправки не
              допускает вовсе — молча, а сервер такие принимает. */}
          <input
            autoCapitalize="none"
            autoComplete="off"
            inputMode="email"
            maxLength={254}
            spellCheck={false}
            type="text"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button disabled={pending} type="submit">{pending ? 'Завожу…' : 'Завести семью'}</button>
      </form>
      {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
      {issued.map((shown) => (
        <ParentInvite email={shown.email} invite={shown.invite} key={shown.invite.path} />
      ))}
    </div>
  );
}

/**
 * Два способа вернуть семье вход, и они не равнозначны. Ссылку оператор только
 * передаёт — пароля он не знает. Поставленный им пароль — это вход в семью,
 * который потом ничем не отличить от родительского, и след от него остаётся
 * только в журнале действий. Поэтому второй способ спрятан за отдельным
 * нажатием и объяснён словами, а не стоит готовым полем рядом с первым.
 */
function ParentPassword({ family, api }: { family: AdminFamily; api: AdminApi }) {
  const [issued, setIssued] = useState<AdminParentInvite[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [setting, setSetting] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  async function issue(): Promise<void> {
    if (issuing) return;
    setIssuing(true);
    setFeedback(null);
    try {
      const { invite } = await api.issueParentInvite(family.parentId);
      setIssued((shown) => [...shown, invite]);
    } catch (error: unknown) {
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Не получилось выпустить ссылку',
      });
    }
    setIssuing(false);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (setting) return;
    if (!isParentPassword(password)) {
      setFeedback({
        kind: 'error',
        text: `Пароль должен быть от ${String(MIN_PASSWORD_LENGTH)} до ${String(MAX_PASSWORD_LENGTH)} знаков`,
      });
      return;
    }
    setSetting(true);
    setFeedback(null);
    try {
      await api.setParentPassword(family.parentId, password);
    } catch (error: unknown) {
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Не получилось поставить пароль',
      });
      setSetting(false);
      return;
    }
    setPassword('');
    setOpen(false);
    setFeedback({
      kind: 'success',
      text: 'Пароль поставлен. Сеансы родителя и устройства его детей отключены.',
    });
    setSetting(false);
  }

  return (
    <div className="admin-family-password">
      <div className="admin-family-actions">
        <button disabled={issuing} type="button" onClick={() => { void issue(); }}>
          {issuing ? 'Выпускаю…' : 'Ссылка на смену пароля'}
        </button>
        <button className="quiet" type="button" onClick={() => setOpen((shown) => !shown)}>
          Задать пароль
        </button>
      </div>
      {open && (
        <form className="form-row admin-set-password" onSubmit={(event) => { void save(event); }}>
          <p className="admin-note" role="note">
            Пароль, поставленный отсюда, знаете и вы: войти этой семьёй можно будет без
            записи о заходе. Ссылка такого не даёт — по ней пароль ставит сам родитель.
          </p>
          <label>
            <span>Новый пароль семьи</span>
            <input
              autoComplete="off"
              maxLength={MAX_PASSWORD_LENGTH}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button disabled={setting} type="submit">
            {setting ? 'Сохраняю…' : 'Сохранить пароль семьи'}
          </button>
        </form>
      )}
      {feedback !== null && <p
        className={`auth-message ${feedback.kind}`}
        role={feedback.kind === 'error' ? 'alert' : 'status'}
      >{feedback.text}</p>}
      {issued.map((invite) => (
        <ParentInvite email={family.email} invite={invite} key={invite.path} />
      ))}
    </div>
  );
}

function Family({
  api,
  family,
  onChild,
  onEnter,
  entering,
}: {
  api: AdminApi;
  family: AdminFamily;
  /** Открыть карточку ребёнка: слой 3 читает только его базу. */
  onChild?: (childId: string) => void;
  onEnter: (childId: string, role: AdminImpersonationRole) => void;
  /** Ребёнок, заход к которому уже начат: две нажатые кнопки — два захода. */
  entering: string | null;
}) {
  return (
    <article className="admin-family">
      <header>
        <h3>{family.email}</h3>
        <span>{family.disabledAt === undefined ? `с ${when(family.createdAt)}` : `отключён ${when(family.disabledAt)}`}</span>
      </header>
      {/* Соседом шапки, а не внутри неё: раскрытая форма пароля шире адреса, и
          в одной с ним строке она сжимала бы его до нескольких букв в столбик.
          Кнопки встают рядом с адресом сеткой самой карточки (`display:
          contents`), а всё, что раскрывается, занимает свою строку целиком.

          Отключённой семье сервер отказывает 409 на обоих маршрутах: кнопка,
          гарантированно кончающаяся отказом, — не действие, а ловушка. */}
      {family.disabledAt === undefined && <ParentPassword api={api} family={family} />}
      {family.children.length === 0
        ? <p className="admin-empty">Детей нет</p>
        : (
          <ul className="admin-children">
            {family.children.map((child) => (
              <li key={child.childId}>
                {/* Имя, состояние и номер — одним блоком: номер стоял отдельной
                    колонкой посреди строки и разрывал подпись ребёнка надвое,
                    оставляя кнопки без общей оси. */}
                <div className="admin-child-copy">
                  <strong>{child.name}</strong>
                  <small>{STATUS_NAMES[child.status]} · {childState(child)}</small>
                  <code>{child.childId}</code>
                </div>
                <div className="admin-child-actions">
                  {/* Карточка предлагается любому: у застрявшего заведения она и
                      нужнее всего — она называет причину, по которой базы нет. */}
                  {onChild !== undefined && (
                    <button className="quiet" type="button" onClick={() => onChild(child.childId)}>
                      Карточка
                    </button>
                  )}
                  {/* Заход предлагается только готовому и не выведенному: у
                      застрявшего заведения базы ещё нет вовсе, а выведенного
                      `isChildServiceable` не отдаёт, — и обе кнопки кончились бы
                      отказом «Ребёнок не найден» на первом же нажатии. */}
                  {child.status === 'ready' && child.retiredAt === undefined && (
                    <>
                      <button
                        disabled={entering !== null}
                        type="button"
                        onClick={() => onEnter(child.childId, 'browser')}
                      >
                        Войти как ребёнок
                      </button>
                      <button
                        disabled={entering !== null}
                        type="button"
                        onClick={() => onEnter(child.childId, 'parent')}
                      >
                        Войти как родитель
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
    </article>
  );
}

/**
 * Почему оператор перестал быть вошедшим. Различие не косметическое: «сессия
 * закончилась» над формой после нажатой самим оператором кнопки «Выйти» —
 * сообщение о поломке, которой не было.
 */
export type AdminSignOutReason = 'expired' | 'logout';

export interface AdminHomeScreenProps {
  api?: AdminApi;
  /** Адрес вошедшего оператора, если он известен: сразу после входа — известен. */
  email?: string;
  /** Перейти к ленте аварий: второй экран админки выбирает корень, а не сводка. */
  onLogs?: () => void;
  /** Перейти к статистике: слой 2 обходит все детские базы и потому не здесь. */
  onStats?: () => void;
  onCourses?: () => void;
  /** Открыть карточку ребёнка: слой 3 живёт своим адресом. */
  onChild?: (childId: string) => void;
  /** Сессии оператора больше нет: решение показать вход принимает корень. */
  onSignedOut: (reason: AdminSignOutReason) => void;
  /**
   * Куда уходить после начала захода. По умолчанию — на корень приложения:
   * cookie захода уже стоит, и там оператора встречают настоящие экраны
   * семьи под несъёмной полосой.
   */
  onEntered?: () => void;
}

/**
 * Главный экран админки: цифры слоя 1 и список семей.
 *
 * Слой 1 не открывает ни одной детской базы, и экран поэтому обязан рисоваться
 * при любом состоянии этих баз — в том числе когда сломаны все разом. Именно в
 * этот момент по нему и смотрят.
 */
export function AdminHomeScreen({
  api = browserAdminApi,
  email,
  onChild,
  onLogs,
  onStats,
  onCourses,
  onSignedOut,
  onEntered = (): void => { window.location.assign('/'); },
}: AdminHomeScreenProps) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Новая попытка после сорвавшейся: эффект сам не повторится (сводка так и
  // остаётся `null`), и без счётчика обрыв сети запирал бы оператора навсегда.
  const [attempt, setAttempt] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [logoutProblem, setLogoutProblem] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [enterProblem, setEnterProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.overview()
      .then((loaded) => { if (active) setOverview(loaded); })
      .catch((error: unknown) => {
        if (!active) return;
        // 401 — не поломка, а кончившаяся сессия оператора. Показанный ошибкой,
        // он предлагал бы «Повторить» там, где повторять нечего: пускать
        // обратно будет только форма входа.
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setProblem(error instanceof Error ? error.message : 'Не получилось загрузить сводку');
      });
    return () => { active = false; };
  }, [api, attempt, onSignedOut]);

  function enter(childId: string, role: AdminImpersonationRole): void {
    if (entering !== null) return;
    setEntering(childId);
    setEnterProblem(null);
    void api.impersonate(childId, role)
      .then(onEntered)
      .catch((error: unknown) => {
        // Кнопки отпираются только здесь, на отказе. `finally` отпирал бы их и
        // на успехе — а уход по `onEntered` (`location.assign`) асинхронный, и
        // в это окно второй щелчок начинал бы второй заход: он гасит первый,
        // сбрасывает счётчик отказов и кладёт в `admin_audit` вторую строку
        // `impersonation-start` на одно намерение оператора.
        setEntering(null);
        // Кончившаяся сессия оператора и здесь не поломка: пускать обратно
        // будет форма входа, а не кнопка «Повторить».
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setEnterProblem(error instanceof Error ? error.message : 'Не получилось зайти в семью');
      });
  }

  function logout(): void {
    if (leaving) return;
    setLeaving(true);
    setLogoutProblem(null);
    void api.logout()
      .then(() => onSignedOut('logout'))
      .catch((error: unknown) => {
        // Cookie оператора `HttpOnly`: снять её клиент не может, и форма входа
        // до подтверждённого ответа сервера была бы ложной — перезагрузка
        // вернула бы живую сессию.
        setLogoutProblem(error instanceof Error ? error.message : 'Не получилось выйти');
      })
      .finally(() => setLeaving(false));
  }

  // Шапка рисуется и над отказом, и над загрузкой. Сводка ломается ровно тогда,
  // когда беда с управляющей базой, — а лента аварий заведена файлом именно
  // ради этого случая и от `control.db` не зависит. Оставить оператора наедине
  // с «Повторить» значило бы отнять у него и ленту, и выход в единственный
  // момент, ради которого они и нужны.
  const header = (
    <>
      <header className="admin-header">
        <div>
          <span>Админка оператора</span>
          <strong>{email ?? 'Оператор'}</strong>
        </div>
        {onStats !== undefined && (
          <button type="button" onClick={onStats}>Статистика</button>
        )}
        {onCourses !== undefined && (
          <button type="button" onClick={onCourses}>Курсы</button>
        )}
        {onLogs !== undefined && (
          <button type="button" onClick={onLogs}>Аварии</button>
        )}
        <button disabled={leaving} type="button" onClick={logout}>
          {leaving ? 'Выхожу…' : 'Выйти'}
        </button>
      </header>
      {logoutProblem !== null && (
        <p className="auth-message error" role="alert">{logoutProblem}</p>
      )}
    </>
  );

  if (problem !== null) {
    return (
      <main className="admin-shell">
        {header}
        <p className="auth-message error" role="alert">{problem}</p>
        <button
          type="button"
          onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
        >
          Повторить
        </button>
      </main>
    );
  }

  if (overview === null) {
    return (
      <main className="admin-shell">
        {header}
        <p role="status">Загружаю сводку…</p>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      {header}
      <p className="admin-stamp">Данные на {when(overview.generatedAt)}</p>
      <Numbers overview={overview} />
      {overview.stuck.length > 0 && (
        <section className="admin-panel">
          <div className="section-heading">
            <p>Дети без базы</p>
            <h2>Заведение не доехало</h2>
          </div>
          <ul className="admin-list">
            {overview.stuck.map((child) => (
              <li key={child.childId}>
                {child.name} · {STATUS_NAMES[child.status]} · заведён {when(child.createdAt)}
                {' '}<code>{child.childId}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {overview.lockouts.length > 0 && (
        <section className="admin-panel">
          <div className="section-heading">
            <p>Счётчик неудачных попыток</p>
            <h2>Вход заперт перебором</h2>
          </div>
          <ul className="admin-list">
            {overview.lockouts.map((lockout) => (
              <li key={`${lockout.scope}-${lockout.kind}-${lockout.key}`}>
                {lockout.key} · {lockout.kind} · неудач {lockout.failures} · ещё{' '}
                {Math.ceil(lockout.retryAfterMs / 60000)} мин
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="admin-panel">
        <div className="section-heading">
          <p>Родители и их дети</p>
          <h2>Семьи</h2>
        </div>
        <NewFamily api={api} onCreated={() => setAttempt((value) => value + 1)} />
        {enterProblem !== null && (
          <p className="auth-message error" role="alert">{enterProblem}</p>
        )}
        {overview.families.length === 0
          ? <p className="admin-empty">Ни одной семьи не заведено</p>
          : overview.families.map((family) => (
            <Family
              api={api}
              key={family.parentId}
              entering={entering}
              family={family}
              onEnter={enter}
              {...(onChild === undefined ? {} : { onChild })}
            />
          ))}
      </section>
    </main>
  );
}
