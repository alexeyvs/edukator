import { useEffect, useState } from 'react';
import { browserAdminApi, type AdminApi, type AdminStats } from '../admin-api';
import { HttpError } from '../http';
import type { AdminSignOutReason } from './AdminHomeScreen';

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

export function statsTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/**
 * Часы человеку. Активное время копится миллисекундами, и показывать их так же
 * бессмысленно, как байты у размера базы: оператор сравнивает порядки величин.
 */
export function hours(ms: number): string {
  return `${(ms / (60 * 60 * 1000)).toFixed(1)} ч`;
}

/**
 * Доля процентами. `undefined` — не ноль: «ни одного ответа ещё не было» и «все
 * ответы мимо» — разные состояния, и второе пишется числом, а первое прочерком.
 */
export function share(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function Engagement({ stats }: { stats: AdminStats }) {
  const { engagement } = stats;
  return (
    <section className="admin-panel">
      <h2>Вовлечённость</h2>
      <dl className="admin-numbers">
        <div>
          <dt>Занимались сегодня</dt>
          <dd>{engagement.activeToday}</dd>
          <small>за 7 дней {engagement.active7Days}, за 30 дней {engagement.active30Days}</small>
        </div>
        <div>
          <dt>Активное время</dt>
          <dd>{hours(engagement.activeMsTotal)}</dd>
          <small>за 7 дней {hours(engagement.activeMs7Days)}</small>
        </div>
        <div>
          <dt>Серии</dt>
          <dd>{engagement.streaks.withCurrent}</dd>
          <small>
            лучшая живая {engagement.streaks.longestCurrent},
            рекорд {engagement.streaks.longestEver}
          </small>
        </div>
        <div>
          <dt>Ушли</dt>
          <dd>{engagement.churned}</dd>
          <small>молчат дольше двух недель</small>
        </div>
      </dl>
      {engagement.churnByWeek.length > 0 && (
        <ul className="admin-list">
          {engagement.churnByWeek.map((week) => (
            <li key={week.week}>
              Неделя {week.week} от заведения · ушло {week.children}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Learning({ stats }: { stats: AdminStats }) {
  const { learning } = stats;
  return (
    <section className="admin-panel">
      <h2>Учебная картина</h2>
      <dl className="admin-numbers">
        <div>
          <dt>Завершённые забеги</dt>
          <dd>{learning.finishedRuns}</dd>
          <small>ответов {learning.answers}, точность {share(learning.accuracy)}</small>
        </div>
        <div>
          <dt>Боссы</dt>
          <dd>{learning.boss.won}</dd>
          <small>
            поражений {learning.boss.lost}, отказов {learning.boss.failed},
            идёт {learning.boss.live}
          </small>
        </div>
        <div>
          <dt>Проверки занятия</dt>
          <dd>{learning.integrity.reviews}</dd>
          <small>
            отказов {learning.integrity.needsRetry},
            отмеченных ответов {learning.integrity.retryItems}
          </small>
        </div>
        <div>
          <dt>Споры</dt>
          <dd>{learning.disputes.total}</dd>
          <small>
            выиграно {share(learning.disputes.upheldShare)}, открыто {learning.disputes.open}
          </small>
        </div>
      </dl>
      <ul className="admin-list">
        {learning.mastery.map((subject) => (
          <li key={subject.subject}>
            {subject.subject} · среднее mastery {subject.average.toFixed(2)} ·
            {' '}тем {subject.topics} · детей {subject.children}
          </li>
        ))}
        {learning.calibrated.map((subject) => (
          <li key={`калибровка-${subject.subject}`}>
            {subject.subject} · калибровку прошли {subject.children}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Content({ stats }: { stats: AdminStats }) {
  const { content } = stats;
  return (
    <section className="admin-panel">
      <h2>Качество контента</h2>
      <dl className="admin-numbers">
        <div>
          <dt>Вызовов codex</dt>
          <dd>{content.codexCalls}</dd>
          {/* Доля брака проверяющего нигде не хранится: она видна только так —
              сколько вызовов ушло на одно новое задание в банке. */}
          <small>
            за {stats.day}, новых заданий {content.tasksAdded},
            {' '}вызовов на задание {content.callsPerTask === undefined
              ? '—'
              : content.callsPerTask.toFixed(1)}
          </small>
        </div>
      </dl>
      {content.emptyBanks.length > 0 && (
        <>
          <h3>Пустые банки</h3>
          <ul className="admin-list">
            {content.emptyBanks.map((topic) => (
              <li key={topic.topicId}>
                <code>{topic.topicId}</code> · у детей: {topic.children}
              </li>
            ))}
          </ul>
        </>
      )}
      {content.worstTopics.length > 0 && (
        <>
          <h3>Худшие темы</h3>
          <ul className="admin-list">
            {content.worstTopics.map((topic) => (
              <li key={topic.topicId}>
                <code>{topic.topicId}</code> · точность {share(topic.accuracy)} ·
                {' '}ответов {topic.answers}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export interface AdminStatsScreenProps {
  api?: AdminApi;
  /** Вернуться к сводке: статистика — второй экран админки, а не приложение. */
  onBack?: () => void;
  /** Открыть карточку ребёнка: слой 3 живёт своим адресом. */
  onChild?: (childId: string) => void;
  /** Сессии оператора больше нет: решение показать вход принимает корень. */
  onSignedOut: (reason: AdminSignOutReason) => void;
}

/**
 * Экран слоя 2: обход всех детских баз.
 *
 * Отметка «данные на 12:41» стоит здесь не для красоты: отчёт живёт пять минут,
 * и без неё оператор читал бы сохранённые числа как нынешние — то есть смотрел
 * бы на состояние до того, как сам что-то починил. Пересчёт заказывается
 * кнопкой: он открывает все детские базы по одной, и делать это на каждом заходе
 * значило бы платить обходом за перезагрузку страницы.
 */
export function AdminStatsScreen({
  api = browserAdminApi,
  onBack,
  onChild,
  onSignedOut,
}: AdminStatsScreenProps) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Заказ отчёта: номер попытки и признак пересчёта вместе, одним состоянием.
   * Номер нужен потому, что эффект сам не повторится, и без него обрыв сети
   * запирал бы оператора на сообщении; признак — потому, что повтор после
   * обрыва не обязан заказывать обход всех баз, а нажатая кнопка — обязана.
   */
  const [request, setRequest] = useState({ attempt: 0, refresh: false });

  useEffect(() => {
    let active = true;
    setBusy(true);
    api.stats(request.refresh)
      .then((loaded) => {
        if (!active) return;
        setStats(loaded);
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // 401 — не поломка, а кончившаяся сессия оператора: пускает обратно
        // только форма входа, а «Повторить» повторяло бы отказ.
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setProblem(error instanceof Error ? error.message : 'Не получилось загрузить статистику');
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, request, onSignedOut]);

  function recount(): void {
    if (busy) return;
    setRequest((previous) => ({ attempt: previous.attempt + 1, refresh: true }));
  }

  function retry(): void {
    setProblem(null);
    setRequest((previous) => ({ attempt: previous.attempt + 1, refresh: false }));
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span>Админка оператора</span>
          <strong>Статистика</strong>
        </div>
        {onBack !== undefined && (
          <button type="button" onClick={onBack}>К сводке</button>
        )}
        <button disabled={busy} type="button" onClick={recount}>
          {busy ? 'Считаю…' : 'Пересчитать'}
        </button>
      </header>

      {problem !== null && (
        <>
          <p className="auth-message error" role="alert">{problem}</p>
          <button type="button" onClick={retry}>Повторить</button>
        </>
      )}

      {problem === null && stats === null && <p role="status">Считаю статистику…</p>}

      {stats !== null && problem === null && (
        <>
          <p className="admin-stamp">Данные на {statsTime(stats.generatedAt)}</p>
          {stats.partial && (
            // Неполнота называется прямо: «активных сегодня двое» из отчёта, в
            // котором треть баз не открылась, читается как факт, а не как
            // «сколько увидели».
            <p className="auth-message error" role="alert">
              Отчёт неполный: прочитаны не все базы.
            </p>
          )}
          <Engagement stats={stats} />
          <Learning stats={stats} />
          <Content stats={stats} />
          {stats.failed.length > 0 && (
            <section className="admin-panel">
              <h2>Базы не открылись</h2>
              <ul className="admin-list">
                {stats.failed.map((child) => (
                  <li key={child.childId}>
                    <code>{child.childId}</code> · {child.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {stats.stale.length > 0 && (
            <section className="admin-panel">
              <h2>Ждут первого захода</h2>
              <ul className="admin-list">
                {stats.stale.map((child) => (
                  <li key={child.childId}>
                    <code>{child.childId}</code> · схема {child.schemaVersion}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="admin-panel">
            <h2>Дети</h2>
            {stats.children.length === 0
              ? <p className="admin-empty">Ни одной прочитанной базы</p>
              : (
                <ul className="admin-list">
                  {stats.children.map((child) => (
                    <li className="admin-list-row" key={child.childId}>
                      {/* Строка и её действие — две половины, а не одна фраза:
                          кнопка, дописанная в конец текста, слипается с ним и
                          читается его продолжением. */}
                      <span>
                        <code>{child.childId}</code> · забегов {child.finishedRuns} ·
                        {' '}ответов {child.answers} · банк {child.bank.valid} ·
                        {' '}время {hours(child.activeMs.total)}
                      </span>
                      {onChild !== undefined && (
                        <button className="quiet" type="button" onClick={() => onChild(child.childId)}>
                          Карточка
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </>
      )}
    </main>
  );
}
