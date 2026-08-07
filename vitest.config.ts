import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'scripts/**/*.ts'],
      // Порог держится на четырёх модулях ядра: они детерминированы, и дефект
      // в них тихо портит учебный план, не роняя ничего. Скрипты извлечения и
      // сборки карты завязаны на PDF и codex, для них общий порог был бы враньём.
      thresholds: {
        'server/{normalize,mastery,scheduler,forecast}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
