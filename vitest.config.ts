import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'scripts/**/*.ts'],
      // Порог держится на ядре, занятии и генерации: все они детерминированы —
      // внешние процессы подменяются через `run`/`produce`/`review`, — и дефект
      // в них тихо портит учебный план, не роняя ничего. Скрипты извлечения и
      // сборки карты завязаны на PDF и codex, для них общий порог был бы враньём.
      thresholds: {
        // Пофайлово, а не в среднем по группе: без этого `server/codex/*.ts`
        // значит «девять файлов в сумме», и `worker.ts` — где живут пороги
        // очереди и отступ при недоступном codex — мог бы упасть до нуля, пока
        // общая цифра держится соседями.
        perFile: true,
        'server/{normalize,mastery,scheduler,forecast}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'server/{session,curriculum,db,json-schema}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'server/routes/*.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'server/codex/*.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Каркас и общие обвязки: `run-child.ts` — единственная граница с
        // внешними процессами, `atomic-write.ts` пишет снимки, лежащие в
        // репозитории. Ни один из них не попадал ни под один порог.
        'server/{index,run-child,atomic-write}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
