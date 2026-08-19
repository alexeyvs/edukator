/**
 * Суточная квота вызовов codex, вложенная в сам `CodexRunner`.
 *
 * Единица счёта — один `runCodexCli`, а не один слот семафора: за одним
 * `budget.run` прячется целый конвейер (батч заданий — это генератор и
 * проверяющий, персональный материал — теория, методист и вопросы теста), и
 * счёт по слотам превратил бы предел 60 в 120-360. Поэтому обёртка надевается
 * на вызов модели, а не на бюджет: где бы вызов ни случился, он спишется ровно
 * один раз.
 *
 * Обёртывается только фон. Разбор спора и проверка ответа идут по живому
 * запросу ученика: остановить их квотой значит молча сломать занятие, а не
 * придержать расход.
 */
import type Database from 'better-sqlite3';
import {
  reserveCodexCall,
  type CodexQuotaState,
} from '../control-db.js';
import { CodexUnavailableError, runCodexCli, type CodexRequest, type CodexRunner } from './client.js';

/**
 * Суточная квота ребёнка исчерпана.
 *
 * Наследуется от `CodexUnavailableError` намеренно: для фонового конвейера
 * исчерпанная квота неотличима от недоступной модели — повторять нечего до
 * московской полуночи. Без наследования генератор потратил бы на отказ все три
 * попытки и, что хуже, отправил бы текст про квоту в промпт следующей под
 * заголовком «исправь эти замечания», а цикл воркера пошёл бы по остальным
 * темам за тем же самым отказом.
 *
 * Отступ воркера при этом растёт до получаса — ровно то, что нужно: раньше
 * полуночи квота не вернётся, а после неё получасовая пауза стоит одного
 * пропущенного цикла.
 */
export class CodexQuotaError extends CodexUnavailableError {
  constructor(
    readonly childId: string,
    readonly state: CodexQuotaState,
  ) {
    super(
      `суточная квота вызовов codex исчерпана для ребёнка ${childId}: ` +
        `${String(state.used)} из ${String(state.limit)} за ${state.day}`,
    );
    this.name = 'CodexQuotaError';
  }
}

export interface QuotedRunnerOptions {
  /** Управляющая база: счётчик квоты общий на все базы ребёнка. */
  control: Database.Database;
  /** Чей расход считаем; квота своя у каждого ребёнка. */
  childId: string;
  /** Что обёртывается; по умолчанию настоящий вызов codex. */
  run?: CodexRunner;
  /** Часы; тесты сдвигают ими московские сутки. */
  now?: () => Date;
  /** Предел на сутки; по умолчанию `CODEX_DAILY_QUOTA`. */
  limit?: number;
}

/**
 * Оборачивает вызов codex списанием квоты.
 *
 * Резерв берётся **до** вызова и не возвращается, чем бы вызов ни кончился:
 * зациклившийся на ошибках конвейер расходует ту же самую модель, что и
 * удачный, и «списываем только за успех» означало бы защиту, которую обходит
 * первая же поломка.
 *
 * Резерв — своя короткая транзакция (`reserveCodexCall`), а сам вызов идёт
 * строго вне её: он занимает минуты, и под WAL всё это время держал бы запись
 * в управляющей базе — то есть вход, семью и квоту остальных детей.
 */
export function createQuotedRunner(options: QuotedRunnerOptions): CodexRunner {
  const { control, childId } = options;
  const run = options.run ?? runCodexCli;

  return async (request: CodexRequest): Promise<string> => {
    // Открытая транзакция здесь — не состояние, а ошибка вызывающего: резерв
    // стал бы точкой сохранения внутри чужой транзакции, а вызов модели ушёл бы
    // под запись на все свои минуты.
    if (control.inTransaction) {
      throw new Error(
        `Резерв квоты codex для ребёнка ${childId} запрошен внутри транзакции управляющей базы`,
      );
    }

    const reservation = reserveCodexCall(
      control,
      childId,
      options.now?.() ?? new Date(),
      options.limit,
    );
    if (!reservation.ok) throw new CodexQuotaError(childId, reservation);

    return run(request);
  };
}
