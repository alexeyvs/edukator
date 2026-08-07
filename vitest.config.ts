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
      },
    },
  },
});
