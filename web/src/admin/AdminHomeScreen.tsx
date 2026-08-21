import { useEffect, useState } from 'react';
import {
  browserAdminApi,
  type AdminApi,
  type AdminChildStatus,
  type AdminFamily,
  type AdminFamilyChild,
  type AdminImpersonationRole,
  type AdminOverview,
} from '../admin-api';
import { HttpError } from '../http';

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

function Family({
  family,
  onChild,
  onEnter,
  entering,
}: {
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
      {family.children.length === 0
        ? <p className="admin-empty">Детей нет</p>
        : (
          <ul className="admin-children">
            {family.children.map((child) => (
              <li key={child.childId}>
                <div>
                  <strong>{child.name}</strong>
                  <small>{STATUS_NAMES[child.status]} · {childState(child)}</small>
                </div>
                <code>{child.childId}</code>
                {/* Карточка предлагается любому: у застрявшего заведения она и
                    нужнее всего — она называет причину, по которой базы нет. */}
                {onChild !== undefined && (
                  <button type="button" onClick={() => onChild(child.childId)}>
                    Карточка
                  </button>
                )}
                {/* Заход предлагается только готовому и не выведенному: у
                    застрявшего заведения базы ещё нет вовсе, а выведенного
                    `isChildServiceable` не отдаёт, — и обе кнопки кончились бы
                    отказом «Ребёнок не найден» на первом же нажатии. */}
                {child.status === 'ready' && child.retiredAt === undefined && (
                  <div className="admin-enter">
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
                  </div>
                )}
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
        // Кончившаяся сессия оператора и здесь не поломка: пускать обратно
        // будет форма входа, а не кнопка «Повторить».
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setEnterProblem(error instanceof Error ? error.message : 'Не получилось зайти в семью');
      })
      .finally(() => setEntering(null));
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
          <button className="admin-header-link" type="button" onClick={onStats}>Статистика</button>
        )}
        {onLogs !== undefined && (
          <button className="admin-header-link" type="button" onClick={onLogs}>Аварии</button>
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
          <h2>Заведение не доехало</h2>
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
          <h2>Вход заперт перебором</h2>
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
        <h2>Семьи</h2>
        {enterProblem !== null && (
          <p className="auth-message error" role="alert">{enterProblem}</p>
        )}
        {overview.families.length === 0
          ? <p className="admin-empty">Ни одной семьи не заведено</p>
          : overview.families.map((family) => (
            <Family
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
