import { useCallback, useEffect, useState } from 'react';
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
  // Новая попытка после сорвавшейся и перезапуск ленты по фильтру: эффект сам
  // не повторится, и без счётчика обрыв сети запирал бы оператора навсегда.
  const [attempt, setAttempt] = useState(0);

  const load = useCallback((query: AdminLogQuery, append: boolean) => {
    setBusy(true);
    api.logs(query)
      .then((page) => {
        setEntries((previous) => (append && previous !== null
          ? [...previous, ...page.entries]
          : page.entries));
        setNextBefore(page.nextBefore);
        setProblem(null);
      })
      .catch((error: unknown) => {
        // 401 — не поломка, а кончившаяся сессия оператора: «Повторить» здесь
        // повторяло бы отказ, а пускает обратно только форма входа.
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setProblem(error instanceof Error ? error.message : 'Не получилось загрузить журнал');
      })
      .finally(() => setBusy(false));
  }, [api, onSignedOut]);

  useEffect(() => {
    load(applied, false);
  }, [load, applied, attempt]);

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
        <button type="submit">Показать</button>
      </form>

      {problem !== null && (
        <>
          <p className="auth-message error" role="alert">{problem}</p>
          <button
            type="button"
            onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
          >
            Повторить
          </button>
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
