import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  createChild,
  createParent,
  listAdminAudit,
  openControlDatabase,
  readAdminImpersonation,
  startImpersonation,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import {
  finishExpiredImpersonation,
  type ImpersonationFinishDeps,
} from '../server/admin/impersonation-finish.js';
import { ImpersonationRefusals } from '../server/admin/impersonation-refusals.js';
import { createAdminAccount } from './server-harness.js';

/** Начало захода и момент, в который он уже просрочен. */
const START = new Date('2026-08-21T10:00:00.000Z');
const LATER = new Date('2026-08-21T12:00:00.000Z');

let dir: string;
let control: Database;
let refusals: ImpersonationRefusals;
let adminId: string;
let childId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-finish-'));
  ensureDataDir(dir);
  control = openControlDatabase(controlDatabasePath(dir));
  const parentId = createParent(control, 'родитель@example.com', START);
  childId = createChild(control, parentId, 'Ученик', START);
  // Заход отказывает `provisioning`-ребёнку так же, как несуществующему:
  // обслуживать его нечем.
  provisionChildDatabase(control, childId, dir);
  adminId = createAdminAccount(control, { now: START }).adminId;
  refusals = new ImpersonationRefusals();
  const started = startImpersonation(control, { adminId, childId, role: 'browser' }, START);
  if (!started.ok) throw new Error(`заход не начался: ${started.reason}`);
});

afterEach(() => {
  control.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(): ImpersonationFinishDeps {
  return { control, refusals };
}

/** Записи о конце захода с их подробностями. */
function endings(): string[] {
  return listAdminAudit(control, { limit: 50, action: 'impersonation-end' }).entries.map(
    (entry) => entry.detail ?? '',
  );
}

/**
 * Отказ вставки в журнал действий: место кончилось ровно между гашением строки
 * и записью о конце. Триггером, а не сломанной таблицей, — снять его потом
 * можно так же точно, как поставить, и повтор идёт по исправной базе.
 */
function breakAudit(): void {
  control.exec(
    `CREATE TRIGGER admin_audit_ломается BEFORE INSERT ON admin_audit
     BEGIN SELECT RAISE(ABORT, 'диск переполнен'); END`,
  );
}

function repairAudit(): void {
  control.exec('DROP TRIGGER admin_audit_ломается');
}

describe('закрытие захода оператора', () => {
  it('пишет конец со счётчиком отказов и гасит строку', () => {
    refusals.record(adminId);
    refusals.record(adminId);

    finishExpiredImpersonation(deps(), adminId, LATER);

    expect(endings()).toEqual(['browser, отказов записи: 2']);
    // Строка погашена: второй раз тот же заход в ленту не попадёт.
    expect(readAdminImpersonation(control, adminId, LATER)).toBeUndefined();
    expect(refusals.count(adminId)).toBe(0);
  });

  it('откатывает гашение строки, когда запись о конце не удалась', () => {
    // Гашение врозь с записью не имеет обратного хода: погашенную строку не
    // отдаёт ни `readCarriedImpersonation`, ни `readAdminImpersonation`, — то
    // есть повтор не находит, что закрывать, и заход остаётся в ленте началом
    // без пары навсегда. Вместе с парой пропадает счётчик отказанных попыток
    // записи в чужую семью — самое содержательное число этой пары.
    refusals.record(adminId);
    refusals.record(adminId);
    refusals.record(adminId);
    breakAudit();

    expect(() => finishExpiredImpersonation(deps(), adminId, LATER)).toThrow();

    expect(endings()).toEqual([]);
    expect(readAdminImpersonation(control, adminId, LATER)).not.toBeUndefined();
    // Счётчик забирается только после фиксации: обнулённый заранее, он оставил
    // бы повтору ноль отказов вместо трёх.
    expect(refusals.count(adminId)).toBe(3);

    repairAudit();
    finishExpiredImpersonation(deps(), adminId, LATER);

    expect(endings()).toEqual(['browser, отказов записи: 3']);
    expect(readAdminImpersonation(control, adminId, LATER)).toBeUndefined();
  });

  it('не трогает счётчик чужого оператора', () => {
    // Счётчик процессный и общий на всех: закрытие одного захода не имеет права
    // унести отказы другого.
    refusals.record('другой-оператор');

    finishExpiredImpersonation(deps(), adminId, LATER);

    expect(refusals.count('другой-оператор')).toBe(1);
  });

  it('молчит, когда закрывать нечего', () => {
    finishExpiredImpersonation(deps(), adminId, LATER);
    finishExpiredImpersonation(deps(), adminId, LATER);

    expect(endings()).toEqual(['browser, отказов записи: 0']);
  });
});
