import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ADMIN_LOG_EVENTS,
  browserAdminApi,
  type AdminApi,
  type AdminLogEntry,
  type AdminLogEvent,
  type AdminLogQuery,
} from '../admin-api';
import { HttpError } from '../http';
import type { AdminSignOutReason } from './AdminHomeScreen';

/** Событие человеку. Слово из журнала — для grep, а не для чтения с экрана. */
export const EVENT_NAMES: Record<AdminLogEvent, string> = {
  'server-error': 'Ошибка сервера',
  'tenant-open-failed': 'База ребёнка не открылась',
  'tenant-detached': 'Файл базы ребёнка подменён',
  'control-error': 'Ошибка управляющей базы',
  'startup-failed': 'Сервер не поднялся',
  'codex-unavailable': 'codex недоступен',
  'codex-run-failed': 'Вызов codex не удался',
  'sweep-failed': 'Обход прогрева не удался',
  'prefetch-failed': 'Ручной прогрев не удался',
  'backup-failed': 'Копия не снялась',
  'login-lockout': 'Вход заперт перебором',
};

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Отметка записи человеку. Секунды здесь не украшение: аварии приходят пачкой,
 * и без них соседние строки выглядят одной и той же.
 */
export function logTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** Ключ строки. Отметка не уникальна — несколько записей одной миллисекунды обычны. */
export function entryKey(entry: AdminLogEntry, index: number): string {
  return `${entry.at}#${index}`;
}

function Details({ entry }: { entry: AdminLogEntry }) {
  return (
    <dl className="admin-log-details">
      {entry.childId !== undefined && (
        <div>
          <dt>Ребёнок</dt>
          <dd><code>{entry.childId}</code></dd>
        </div>
      )}
      {entry.route !== undefined && (
        <div>
          <dt>Маршрут</dt>
          <dd><code>{entry.route}</code></dd>
        </div>
      )}
      {entry.status !== undefined && (
        <div>
          <dt>Код ответа</dt>
          <dd>{entry.status}</dd>
        </div>
      )}
      {/* Подробности — то место, где лежит стек и путь к файлу. Свёрнутыми они
          лежат намеренно: развёрнутые, они выталкивали бы с экрана саму ленту. */}
      {entry.detail !== undefined && (
        <div className="admin-log-detail">
          <dt>Подробности</dt>
          <dd><pre>{entry.detail}</pre></dd>
        </div>
      )}
    </dl>
  );
}

export interface AdminLogsScreenProps {
  api?: AdminApi;
  /** Вернуться к сводке: лента — второй экран админки, а не отдельное приложение. */
  onBack?: () => void;
  /** Сессии оператора больше нет: решение показать вход принимает корень. */
  onSignedOut: (reason: AdminSignOutReason) => void;
}

/**
 * Лента аварий: журнал файлом, прочитанный хвостом.
 *
 * Страницы **добавляются** к уже показанным, а не заменяют их: курсор `before`
 * шагает от последней отданной записи, и заменой оператор терял бы всё, что
 * успел прочитать выше. Смена фильтра, наоборот, начинает ленту заново —
 * дописать отфильтрованное к нефильтрованному значило бы показать смесь двух
 * разных вопросов.
 */
export function AdminLogsScreen({ api = browserAdminApi, onBack, onSignedOut }: AdminLogsScreenProps) {
  const [event, setEvent] = useState<AdminLogEvent | ''>('');
  const [child, setChild] = useState('');
  /**
   * Применённый фильтр отдельно от набранного: ребёнок вводится руками, и
   * запрос на каждую букву перечитывал бы хвост журнала целиком — по разу на
   * знак идентификатора.
   */
  const [applied, setApplied] = useState<AdminLogQuery>({});
  const [entries, setEntries] = useState<AdminLogEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  /**
   * Номер последнего запроса. Без него догрузка «Показать ещё», доехавшая
   * после смены фильтра, дописала бы нефильтрованный хвост к свежему списку и
   * вернула бы его курсор — то есть показала бы смесь двух разных вопросов,
   * ровно ту, которую отдельный `applied` и заведён предотвращать.
   */
  const generation = useRef(0);
  /**
   * Что именно сорвалось. «Повторить» обязано повторить **тот же** запрос:
   * догрузка, перезапущенная первой страницей, молча отматывала бы ленту к
   * началу — оператор, ушедший на шестой экран вглубь журнала, после одного
   * обрыва сети оказывался бы в начале, и ничто на экране об этом не сказало
   * бы.
   */
  const failed = useRef<{ query: AdminLogQuery; append: boolean } | null>(null);

  const load = useCallback((query: AdminLogQuery, append: boolean) => {
    const mine = generation.current + 1;
    generation.current = mine;
    setBusy(true);
    failed.current = { query, append };
    api.logs(query)
      .then((page) => {
        if (generation.current !== mine) return;
        setEntries((previous) => (append && previous !== null
          ? [...previous, ...page.entries]
          : page.entries));
        setNextBefore(page.nextBefore);
        setProblem(null);
        failed.current = null;
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        // 401 — не поломка, а кончившаяся сессия оператора: «Повторить» здесь
        // повторяло бы отказ, а пускает обратно только форма входа.
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setProblem(error instanceof Error ? error.message : 'Не получилось загрузить журнал');
      })
      .finally(() => {
        if (generation.current === mine) setBusy(false);
      });
  }, [api, onSignedOut]);

  // Первая страница применённого фильтра. Повтор сорвавшегося запроса сюда не
  // ходит: он повторяет **свой** запрос, а не начало ленты, — см. `failed`.
  useEffect(() => {
    failed.current = null;
    load(applied, false);
  }, [load, applied]);

  /** Повторить именно то, что сорвалось: первую страницу или догрузку. */
  function retry(): void {
    const last = failed.current;
    setProblem(null);
    if (last === null) load(applied, false);
    else load(last.query, last.append);
  }

  /** Применить набранный фильтр: лента начинается заново, а не дописывается. */
  function apply(): void {
    setOpen(null);
    setEntries(null);
    setApplied({
      ...(event === '' ? {} : { event }),
      ...(child === '' ? {} : { child }),
    });
  }

  function more(): void {
    if (nextBefore === undefined || busy) return;
    load({ ...applied, before: nextBefore }, true);
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span>Админка оператора</span>
          <strong>Аварии</strong>
        </div>
        {onBack !== undefined && (
          <button type="button" onClick={onBack}>К сводке</button>
        )}
      </header>

      <form
        className="admin-log-filters"
        onSubmit={(submit) => { submit.preventDefault(); apply(); }}
      >
        <label>
          Событие
          <select value={event} onChange={(input) => setEvent(input.target.value as AdminLogEvent | '')}>
            <option value="">Любое</option>
            {ADMIN_LOG_EVENTS.map((known) => (
              <option key={known} value={known}>{EVENT_NAMES[known]}</option>
            ))}
          </select>
        </label>
        <label>
          Ребёнок
          <input
            type="text"
            value={child}
            placeholder="Идентификатор ребёнка"
            onChange={(input) => setChild(input.target.value)}
          />
        </label>
        {/*
          Кнопка не запирается на время загрузки намеренно: медленный запрос
          иначе запирал бы и форму, а от смеси двух ответов защищает не запрет
          спрашивать, а номер запроса.
        */}
        <button type="submit">Показать</button>
      </form>

      {problem !== null && (
        <>
          <p className="auth-message error" role="alert">{problem}</p>
          <button type="button" onClick={retry}>Повторить</button>
        </>
      )}

      {problem === null && entries === null && (
        <p role="status">Загружаю журнал…</p>
      )}

      {problem === null && entries !== null && entries.length === 0 && (
        // Пустой журнал — не поломка: на исправной машине это обычное дело, и
        // «не получилось загрузить» здесь было бы прямой ложью.
        <p className="admin-empty">Аварий не было</p>
      )}

      {entries !== null && entries.length > 0 && (
        <ul className="admin-log">
          {entries.map((entry, index) => {
            const key = entryKey(entry, index);
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-expanded={open === key}
                  onClick={() => setOpen((current) => (current === key ? null : key))}
                >
                  <span className="admin-log-when">{logTime(entry.at)}</span>
                  <span className="admin-log-event">{EVENT_NAMES[entry.event]}</span>
                  <span className="admin-log-message">{entry.message}</span>
                </button>
                {open === key && <Details entry={entry} />}
              </li>
            );
          })}
        </ul>
      )}

      {nextBefore !== undefined && problem === null && (
        <button className="admin-log-more" disabled={busy} type="button" onClick={more}>
          {busy ? 'Загружаю…' : 'Показать ещё'}
        </button>
      )}
    </main>
  );
}
