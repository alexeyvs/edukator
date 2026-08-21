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
 * Гашение строки сюда не входит намеренно — её гасит либо выход, либо старт
 * следующего захода, и второе гашение стёрло бы отметку времени того, которое
 * уже состоялось.
 */
import type { Database } from 'better-sqlite3';
import { recordAdminAudit, type ImpersonationPrincipal } from '../control-db.js';
import type { ImpersonationRefusals } from './impersonation-refusals.js';

export interface ImpersonationFinishDeps {
  control: Database;
  /** Счётчик отказов первого замка: он и попадает в запись о конце захода. */
  refusals: ImpersonationRefusals;
  /** Соединения только для чтения; на маршрутных тестах второго замка нет. */
  impersonations?: { close(childId: string): void };
}

/** Пишет `impersonation-end` со счётчиком отказов и закрывает соединение захода. */
export function finishImpersonation(
  deps: ImpersonationFinishDeps,
  session: ImpersonationPrincipal,
  at: Date,
): void {
  const refused = deps.refusals.take(session.adminId);
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
  deps.impersonations?.close(session.childId);
}
