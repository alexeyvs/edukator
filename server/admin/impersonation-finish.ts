/**
 * Закрытие захода оператора: запись в журнал действий и своё соединение.
 *
 * Отдельным модулем, а не функцией внутри маршрута имперсонации, потому что
 * закрывают заход **два** маршрута: явный выход и выход из самой админки. Без
 * второго оператор, нажавший «Выйти» в панели, оставался бы с живой cookie
 * захода — а она выигрывает у собственных cookie первым же разбором
 * предъявителя, так что его собственное приложение молча показывало бы чужую
 * семью, и снять заход было бы уже нечем: `DELETE /api/admin/impersonate`
 * требует админской сессии, которую выход только что погасил.
 *
 * Саму строку гасит вызывающий — выход знает её токен, старт следующего захода
 * и подбор просроченного знают номер, — но делает это **внутри** здешней
 * транзакции: погашенная строка закрывающим дверям больше не видна, и отказ
 * записи после отдельного гашения оставил бы заход без пары в ленте навсегда.
 */
import type { Database } from 'better-sqlite3';
import {
  readAdminImpersonation,
  recordAdminAudit,
  revokeImpersonationRow,
  type ImpersonationPrincipal,
} from '../control-db.js';
import type { ImpersonationRefusals } from './impersonation-refusals.js';

export interface ImpersonationFinishDeps {
  control: Database;
  /** Счётчик отказов первого замка: он и попадает в запись о конце захода. */
  refusals: ImpersonationRefusals;
  /** Соединения только для чтения; на маршрутных тестах второго замка нет. */
  impersonations?: { close(childId: string): void };
}

/** Cleanup that is safe only after the surrounding database transaction commits. */
export type ImpersonationFinishCleanup = () => void;

/**
 * Adds the revoke + audit mutation to the caller's current transaction.
 *
 * The returned cleanup deliberately does not run here: callers which combine
 * the end with another database mutation (login, logout, replacement start)
 * must first commit the whole unit. Otherwise a later rollback would restore
 * the row while its process-local refusal counter and readonly handle had
 * already been discarded.
 */
export function mutateImpersonationFinish(
  deps: ImpersonationFinishDeps,
  session: ImpersonationPrincipal,
  at: Date,
  revoke: (control: Database) => void,
): ImpersonationFinishCleanup {
  const refused = deps.refusals.count(session.adminId);
  revoke(deps.control);
  recordAdminAudit(
    deps.control,
    {
      adminId: session.adminId,
      action: 'impersonation-end',
      childId: session.childId,
      parentId: session.parentId,
      detail: `${session.role}, отказов записи: ${refused}`,
    },
    at,
  );
  return () => {
    deps.refusals.take(session.adminId);
    deps.impersonations?.close(session.childId);
  };
}

/**
 * Пишет `impersonation-end` со счётчиком отказов, гасит строку захода и
 * закрывает его соединение.
 *
 * Гашение приходит вызывающим (`revoke`), а не выписано здесь, потому что
 * строку называют по-разному: выход знает токен, старт следующего захода и
 * подбор просроченного — номер строки. Но выполняется оно **внутри** той же
 * транзакции, что и запись в журнал действий, и это не удобство, а условие:
 * порознь они дают состояние, из которого нет выхода. Погашенную строку не
 * находит ни одна из закрывающих дверей (`readCarriedImpersonation` и
 * `readAdminImpersonation` смотрят только незакрытые), так что отказ записи
 * после успешного гашения означает заход, у которого начала пара уже не
 * появится никогда — вместе со счётчиком отказанных попыток записи в чужую
 * семью, самым содержательным числом этой пары. Повтор при этом безопасен:
 * откатившееся гашение возвращает строку тем же дверям.
 *
 * Счётчик отказов по той же причине **читается** до транзакции, а забирается
 * после её фиксации: обнулённый заранее, он терялся бы на откате. Правило
 * самого счётчика («читать и сбрасывать раздельно нельзя») этим не нарушается —
 * между чтением и `take` не выполняется ничего чужого: better-sqlite3
 * синхронен, и следующий заход начаться посреди этих строк не может.
 */
export function finishImpersonation(
  deps: ImpersonationFinishDeps,
  session: ImpersonationPrincipal,
  at: Date,
  revoke: (control: Database) => void,
): void {
  let cleanup: ImpersonationFinishCleanup | undefined;
  deps.control
    .transaction(() => {
      cleanup = mutateImpersonationFinish(deps, session, at, revoke);
    })
    .immediate();
  cleanup?.();
}

/**
 * Подбирает **просроченный** заход самого оператора: гасит строку, пишет конец
 * и закрывает соединение.
 *
 * Нужна потому, что закрытие по cookie срабатывает не всегда: `Max-Age` cookie
 * захода равен его сроку, и брошенная на час вкладка возвращается уже без неё —
 * то есть ровно в том случае, ради которого запись о конце и заводили («просто
 * закрыл вкладку»), закрывать было бы нечего. Строку тогда называет `admin_id`.
 *
 * Живой заход не трогается намеренно: он может идти в другой вкладке, и вход в
 * админку с третьей машины не повод считать его законченным. Вытеснение живого
 * остаётся делом старта следующего захода, который его и гасит.
 */
export function finishExpiredImpersonation(
  deps: ImpersonationFinishDeps,
  adminId: string,
  at: Date,
): void {
  const unfinished = readAdminImpersonation(deps.control, adminId, at);
  if (unfinished === undefined) return;
  finishImpersonation(deps, unfinished.session, at, (control) => {
    revokeImpersonationRow(control, unfinished.id, at);
  });
}
