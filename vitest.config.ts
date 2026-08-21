import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'web/**/*.test.ts', 'web/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: [
        'server/**/*.ts', 'scripts/**/*.ts',
        'web/src/{home,profile,run,boss,parents,auth,family,admin}-api.ts',
        'web/src/{BossScreen,ParentsScreen,App,LoginScreen,FamilyScreen,InviteScreen,JoinScreen}.tsx',
        'web/src/{http,app-route}.ts',
        'web/src/admin/**/*.tsx',
      ],
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
        // Модули этапа забега и триажа держат калибровку, жизненный цикл и
        // общий бюджет codex. Среднее с давно покрытым ядром скрыло бы
        // непроверенную ветку именно в новом пользовательском потоке.
        'server/{run,triage,xp,session-error}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'server/{boss-fight,boss-loss,boss-prep,boss-rules,parents,streak}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'server/boss.ts': {
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
        // Многоарендность: `control-db` держит миграцию управляющей базы,
        // `secrets` — хеши пароля и PIN, `parent-pin` — pepper и отказ без
        // него, `auth` — разрешение предъявителя,
        // `tenant-registry` — открытие детской базы. Ошибка здесь пускает
        // одного арендатора в чужие данные, а не портит учебный план, и
        // `server/**` без поимённого порога оставила бы её на усмотрение
        // средней цифры по каталогу.
        'server/{control-db,secrets,parent-pin,auth,tenant-registry}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Каталог данных, замок каталога, адрес клиента, снимок базы и
        // разделённое спорное состояние появились вместе с арендаторами и
        // тоже не попадали ни под один порог.
        'server/{data-dir,data-lock,client-address,backup,dispute-coordinator}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Маршруты входа и семьи названы отдельно: `server/routes/*.ts` выше
        // задаёт тот же порог, но перечисление руками не даст новому маршруту
        // аутентификации молча выпасть, если общий шаблон когда-нибудь сузят.
        'server/routes/{auth,family,gate,tenant-context,token-privacy}.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'server/codex/concurrency.ts': {
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
        'web/src/{home,profile,run,boss,parents}-api.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'web/src/{BossScreen,ParentsScreen}.tsx': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Экраны и адаптеры входа: пароль, ссылки и состав семьи — весь
        // клиентский путь многоарендности. Без своего порога он не попадал ни
        // под один шаблон, и дефект в нём переживал полностью зелёный прогон.
        'web/src/{auth,family}-api.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'web/src/{App,LoginScreen,FamilyScreen,InviteScreen,JoinScreen}.tsx': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'web/src/http.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Админка оператора. Её модули видят сразу все семьи, поэтому непокрытая
        // ветка здесь — не испорченный учебный план одного ребёнка, а чужие
        // данные в чужих руках. `server/**` и `web/src/**` под порог целиком не
        // заведены, так что без поимённого шаблона все эти файлы остались бы
        // вовсе без требования.
        'server/admin/**/*.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Маршруты админки названы отдельно от `server/routes/*.ts`: тот шаблон
        // не заглядывает в подкаталог, и `admin/` под него не попадает.
        'server/routes/admin/*.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Выбор соединения под запрос: ветка «пишущая аренда и будильник
        // прогрева» против ветки «второй handle только для чтения». Это и есть
        // второй замок захода оператора, и мерить его обязательно отдельно —
        // `server/*.ts` поимённого шаблона на него не имеет.
        'server/tenant-opener.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Журнал аварий — единственный след упавшего запроса после перехода с
        // journald: ротация и хвост не имеют права оказаться непроверенными.
        'server/log.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'web/src/admin-api.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'web/src/admin/**/*.tsx': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Выбор состояния клиента вынесен в чистую функцию именно ради теста:
        // порог держит его отдельно от `App.tsx`, где он раньше жил веткой.
        'web/src/app-route.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
