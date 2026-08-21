/**
 * HTTP-граница слоя 2: обход всех детских баз, отданный с отметкой времени.
 *
 * Кеш живёт снаружи маршрута (`AdminStatsCache`) и один на процесс: посчитанный
 * отчёт обязан пережить запрос, иначе открытый на стене экран читал бы все базы
 * при каждом обновлении страницы. Пересчёт заказывается явным `?refresh=1` —
 * кнопкой, а не заходом.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AdminStats, AdminStatsCache } from '../../admin/stats.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';

export interface AdminStatsRoutesOptions {
  context: AdminContextResolver;
  cache: AdminStatsCache;
}

/**
 * Отчёт с признаком неполноты. Неоткрывшаяся и отложенная по схеме база — не
 * пятисотка: числа по остальным детям посчитаны и нужны прямо сейчас. Но и
 * молчать о пропуске нельзя — «активных сегодня двое» из отчёта, в котором
 * треть баз не открылась, читается как факт, а не как «сколько увидели».
 *
 * `skipped` в неполноту не входит: застрявшее заведение и выведенный ребёнок —
 * это состояние, названное отдельным списком, а не сорвавшееся чтение.
 */
export interface AdminStatsResponse extends AdminStats {
  partial: boolean;
}

export function registerAdminStatsRoutes(
  app: FastifyInstance,
  options: AdminStatsRoutesOptions,
): void {
  app.get('/api/admin/stats', (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const refresh = query['refresh'] === '1';
    try {
      // Принудительный пересчёт синхронно обходит все детские базы. Хотя HTTP-
      // метод безопасный, чужая страница не должна уметь обходить пятиминутный
      // кеш и занимать цикл событий серией запросов с админской cookie.
      options.context(request, { allow: ROUTE_ACCESS.admin, mutating: refresh });
    } catch (error) {
      return failAuth(reply, error);
    }
    const stats = options.cache.read({ refresh });
    const response: AdminStatsResponse = {
      ...stats,
      partial: stats.failed.length > 0 || stats.stale.length > 0,
    };
    return reply.send(response);
  });
}

/**
 * Заглушка на сервере без управляющей базы: список детей брать неоткуда, а
 * пустой отчёт читался бы как «детей нет».
 */
export function registerUnavailableAdminStats(app: FastifyInstance, reason: string): void {
  app.get('/api/admin/stats', (_request, reply: FastifyReply) =>
    reply.code(503).send({ error: `Статистика недоступна: ${reason}` }));
}
