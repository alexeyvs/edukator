# Настраиваемые учебные курсы

## Overview

Заменить встроенный список из математики, русского и английского для 7 класса
на глобальный каталог произвольных курсов, которыми оператор управляет через
админку. Курс содержит произвольные название и класс, версионированную карту тем
и загруженные PDF-источники. Сканированные учебники обязательно проходят OCR;
релевантные страницы используются при построении программы и генерации заданий.

Родитель назначает ребёнку опубликованный курс целиком и при необходимости
отключает отдельные темы. По умолчанию доступны все темы, включая добавленные в
следующих редакциях. Опубликованное обновление применяется ко всем назначениям,
сохраняет прогресс и не ломает уже начатый забег.

Решение интегрируется с существующей многоарендной архитектурой через
`CurriculumProvider`: управляющая база хранит каталог и назначения, а учебное
ядро получает готовый персональный `TopicGraph` и не обращается к `control.db`.
Согласованный дизайн: `docs/superpowers/specs/2026-08-22-configurable-courses-design.md`.

## Context (from discovery)

- Жёсткий список и SQLite `CHECK` находятся в `server/db.ts`; граф загружается
  из трёх файлов в `server/curriculum.ts`.
- Один глобальный `TopicGraph` создаётся в `server/index.ts`, передаётся в
  `server/tenant-registry.ts`, маршруты занятия, координаторы, прогрев,
  имперсонацию и админскую статистику.
- Предметные циклы и типы есть в `server/routes/run.ts`,
  `server/routes/triage.ts`, `server/subject-calibration.ts`,
  `server/learning-prep.ts`, `server/codex/*`, `scripts/prefetch.ts` и
  `server/admin/stats.ts`.
- Глобальные сущности семей, детей, операторов и аудит уже живут в
  `server/control-db.ts`; права родителя реализованы в `server/routes/family.ts`,
  права оператора — в `server/routes/admin/*`.
- Родительский UI находится в `web/src/FamilyScreen.tsx`, админский каркас — в
  `web/src/admin/AdminApp.tsx`, ученический план — в `web/src/HomeScreen.tsx`.
  `web/src/subject-meta.ts` и `web/src/home-api.ts` знают три предмета явно.
- Текущий OCR в `scripts/ocr-pdf.swift` использует macOS Vision и не подходит
  для Linux VPS. Прод разворачивается `deploy.sh` и
  `scripts/deploy-release.sh` под systemd.
- `server/codex/client.ts` централизует безопасный запуск Codex CLI; локальная
  версия CLI поддерживает `codex exec --image`.
- `scripts/backup.ts` сейчас снимает только `control.db` и детские базы; каталог
  артефактов курса потребуется включить отдельно.
- Проект использует Vitest, Testing Library и Playwright. Перед коммитом должны
  проходить `npm test`, `npm run coverage`, `npm run typecheck`, `npm run lint`,
  `npm run build:web`; для UI/HTTP также `npm run test:e2e`.
- CLI `ralphex` установлен: `/opt/homebrew/bin/ralphex`.

## Development Approach

- **Testing approach**: regular — сначала минимальная реализация логического
  шага, затем обязательные success/error/edge-тесты в том же шаге.
- Выполнять задачи последовательно и полностью; не начинать следующую при
  красных тестах.
- Делать небольшие совместимые изменения и сохранять существующие поля
  `subject` в БД/API как идентификатор курса, пока отдельное переименование не
  даёт пользовательской пользы.
- Для каждого нового или изменённого поведения добавлять отдельные тесты.
- После каждой задачи запускать её целевые тесты и typecheck; полный набор
  гейтов выполняется в задаче приёмки.
- При изменении объёма немедленно обновлять этот план.

## Testing Strategy

- Unit: модель каталога, миграции, графы, назначения, кеш, OCR-адаптер,
  безопасное файловое хранение, retrieval и Codex-аргументы.
- HTTP: роли администратора/родителя/ребёнка, публикация, повторяемость,
  ограничения upload и динамические учебные ответы.
- UI: Testing Library для каталога администратора, назначений родителя,
  динамических карточек и состояний обработки.
- E2E: создание произвольного курса без файлов/констант репозитория, OCR через
  управляемую заглушку, назначение, исключение темы, триаж, занятие и новая
  редакция.
- OCR smoke: отдельная команда на маленьком русском скане в подготовленной
  Linux-среде; обычные unit-тесты не зависят от внешних бинарников.
- Миграция: фикстуры `control.db` версии 2 и детской базы версии 17 с реальными
  забегами, попытками и прогнозами.

## Progress Tracking

Отмечать выполненные пункты `[x]` сразу. Новые пункты добавлять с префиксом ➕,
блокеры — с ⚠️. Ralphex после полного выполнения переносит план в
`docs/plans/completed/`.

## What Goes Where

Checkbox-пункты ниже описывают только автоматизируемые изменения в репозитории.
Ручная установка пакетов и проверка боевого VPS находятся в `Post-Completion` и
не являются отдельными итерациями ralphex.

## Implementation Steps

### Task 1: Сделать идентификатор курса динамическим и мигрировать детскую БД

- [x] в `server/db.ts` и `server/curriculum.ts` заменить закрытый union `Subject`
  на строковый `CourseId`, сохранив поле `subject` как совместимое имя course ID
- [x] добавить в `TopicGraph` метаданные курса (`title`, `grade`, revision) и
  научить файловый legacy-loader обнаруживать валидные карты без цикла по
  `SUBJECTS`
- [x] обновить `schemas/curriculum.json` и парсеры: убрать enum трёх предметов,
  валидировать строковый ID, зарезервировать `overall`, а новые стабильные ID тем
  назначать сервером, не доверяя модели
- [x] поднять `SCHEMA_VERSION`, снять `CHECK subject IN (...)` с `runs`,
  `forecast_snapshots` и `learning_materials`, обновив `validateSchema`
- [x] добавить nullable revision scope в `runs`, `task_bank`, `boss_batches` и
  `learning_materials`, чтобы контент одной редакции не переиспользовался другой
- [x] обновить низкоуровневые типы ядра так, чтобы произвольный корректный ID
  компилировался и проходил через forecast/scheduler/session без allow-list
- [x] написать миграционные тесты версии 17: вся цепочка FK runs/task bank/
  attempts/disputes/boss/learning/integrity, прогнозы и индексы сохраняются;
  произвольный course ID принимается
- [x] написать тесты loader/graph на произвольные названия файлов, дубли,
  неверные связи и метаданные курса
- [x] запустить `npx vitest run tests/db.test.ts tests/curriculum.test.ts tests/forecast.test.ts tests/scheduler.test.ts` и `npm run typecheck`

### Task 2: Добавить версионированный каталог курсов в control.db

- [x] расширить миграцию и валидацию `server/control-db.ts` нормализованными
  таблицами courses/revisions/topics/revision topics/prereqs, источников,
  страниц/chunks, contentless FTS5 и перезапускаемых catalog jobs
- [x] реализовать `server/course-catalog.ts`: создание курса/черновика,
  клонирование редакции, стабильные topic ID, optimistic revision check,
  валидация графа, атомарная публикация и архивирование
- [x] запретить изменение опубликованных редакций на уровне repository API и
  обеспечить один редактируемый черновик на курс
- [x] реализовать идемпотентный bootstrap трёх legacy-карт из `content/curriculum`
  с сохранением `math/russian/english` и существующих `topic_id`
- [x] написать тесты миграции `CONTROL_SCHEMA_VERSION = 2`, CRUD, конфликтов
  редакций, циклов/ссылок, повторного bootstrap и транзакционного отката публикации
- [x] запустить `npx vitest run tests/control-db.test.ts tests/course-catalog.test.ts` и `npm run typecheck`

### Task 3: Добавить назначения и CurriculumProvider

- [x] добавить в `control.db` таблицы `child_courses` и
  `child_topic_exclusions` с FK, уникальностью и сохранением истории при снятии
  назначения
- [x] реализовать `server/course-assignments.ts` для назначения/снятия курса и
  замены набора исключений одной транзакцией
- [x] при legacy-bootstrap назначить три исходных курса всем существующим детям,
  не восстанавливая снятые позднее назначения при повторном запуске
- [x] реализовать `server/curriculum-provider.ts`, возвращающий immutable
  `CurriculumSnapshot` из опубликованных редакций, назначений и исключений
- [x] добавить cache generation/invalidation для публикации, назначения и
  архивирования; новое опубликованное topic автоматически включать, если оно не
  исключено явно
- [x] написать тесты правдоподобных наборов из нескольких классов, отсутствия
  назначений, исключений, архивных тем, новой редакции и кеш-инвалидации
- [x] запустить `npx vitest run tests/course-assignments.test.ts tests/curriculum-provider.test.ts tests/control-db.test.ts` и `npm run typecheck`

### Task 4: Привязать арендатора и активный забег к снимку программы

- [x] заменить фиксированный `graph` в `TenantRegistry` на resolver снимков и
  добавить curriculum snapshot в `Tenant`/tenant context
- [x] при открытии/обновлении арендатора синхронизировать `topic_state` только с
  разрешимыми темами, не удаляя stale/архивную историю
- [x] сохранять `course_revision_id` при старте run/triage/boss/lesson и
  разрешать незаконченный забег по зафиксированной редакции
- [x] перевести `DisputeCoordinator`, integrity и impersonation tenant с
  пожизненного графа на снимок конкретной операции
- [x] обеспечить, что смена назначения/публикация во время запроса применяется
  со следующей операции и не закрывает используемое SQLite-соединение
- [x] обновить тесты реестра, контекста, имперсонации, споров и активного забега,
  включая legacy-run без revision ID
- [x] запустить `npx vitest run tests/tenant-registry.test.ts tests/tenant-context.test.ts tests/impersonation-tenants.test.ts tests/dispute-coordinator.test.ts tests/integrity.test.ts tests/run.test.ts` и `npm run typecheck`

### Task 5: Перевести HTTP учебного ядра на персональный граф

- [x] убрать глобальный graph из route options и брать снимок из tenant context
  в session/run/triage/boss/learning/parents/profile маршрутах
- [x] заменить циклы по `SUBJECTS` в плане, прогнозе, калибровке и learning prep
  на курсы текущего `CurriculumSnapshot`
- [x] возвращать в API карточек метаданные курса: `courseId`, `title`, `grade`,
  revision и тему; валидировать ID по снимку ребёнка, а не глобальному allow-list
- [x] добавить пустое состояние для ребёнка без назначений и запрет старта
  неназначенного/исключённого курса с безопасным 4xx
- [x] обновить unit/route-тесты успеха, отсутствия назначения, исключения,
  публикации новой редакции и незаконченного старого run
- [x] запустить `npx vitest run tests/session-routes.test.ts tests/run-routes.test.ts tests/triage-routes.test.ts tests/boss-routes.test.ts tests/learning-routes.test.ts tests/parents-routes.test.ts tests/profile-routes.test.ts` и `npm run typecheck`

### Task 6: Перевести фоновые процессы, seed bank и админскую статистику

- [x] получать снимок ребёнка на каждом шаге `WarmupDispatcher`, codex worker и
  `learning-prep`, не удерживая общий graph после публикации
- [x] переделать `server/codex/seed-bank.ts` и `scripts/prefetch.ts` на
  динамические курсы; legacy JSON seeds использовать только там, где они есть
- [x] обновить `server/admin/stats.ts`, `server/admin/child-detail.ts` и readonly
  обход так, чтобы агрегаты группировались по course ID и получали display metadata
- [x] сохранить изоляцию отказов: битая программа/источник одного курса или
  ребёнка не останавливает обработку остальных и попадает в failure report
- [x] написать тесты диспетчера, prefetch, seed bank, статистики и readonly-card
  с произвольным курсом и разными назначениями детей
- [x] запустить `npx vitest run tests/codex-dispatcher.test.ts tests/codex-worker.test.ts tests/codex-seed-bank.test.ts tests/prefetch.test.ts tests/admin-stats.test.ts tests/admin-child-detail.test.ts` и `npm run typecheck`

### Task 7: Реализовать админское API каталога и ручного редактора тем

- [x] добавить `server/routes/admin/courses.ts` и зарегистрировать маршруты в
  `server/index.ts`: список, карточка, создание, правка метаданных, draft,
  редактирование тем, публикация и архивирование
- [x] ввести строгие схемы/пределы входных данных, idempotency для публикации и
  optimistic conflict при редактировании устаревшего черновика
- [x] разрешить операции только существующему admin context; родительские,
  детские и impersonated предъявители должны получать отказ
- [x] писать create/update/publish/archive/retry в `admin_audit` без содержания
  учебников и без локальных путей
- [x] реализовать unavailable-маршруты для случая недоступной управляющей базы
- [x] написать route-тесты happy path, невалидного графа, конфликта, повторной
  публикации, архивирования и всех ролей
- [x] запустить `npx vitest run tests/admin-courses-routes.test.ts tests/admin-audit-routes.test.ts tests/auth.test.ts` и `npm run typecheck`

### Task 8: Реализовать родительское API назначений

- [x] расширить `server/routes/family.ts` чтением опубликованного каталога и
  текущих назначений каждого ребёнка
- [x] добавить idempotent PUT/DELETE назначения и замену исключений с проверкой,
  что курс опубликован, тема активна, а ребёнок принадлежит родителю
- [x] после успешного изменения инвалидировать provider; снятие назначения не
  удаляет детскую БД и не обрывает активный run
- [x] не раскрывать черновые/архивные курсы и данные источников родителю; для
  чужого/несуществующего ребёнка сохранить одинаковый ответ
- [x] написать API-тесты назначения всех тем, исключений, новых тем редакции,
  повторного назначения, чужого ребёнка и конкурентного обновления
- [x] запустить `npx vitest run tests/family-routes.test.ts tests/course-assignments.test.ts tests/auth-routes.test.ts` и `npm run typecheck`

### Task 9: Добавить безопасное хранилище PDF и upload API

- [x] подключить потоковый multipart-парсер с явными пределами и реализовать
  `server/course-artifacts.ts` под отдельным каталогом внутри `EDUKATOR_DATA_DIR`
- [x] проверять `%PDF-`, qpdf-структуру, размер/страницы, SHA-256 и канонический
  путь; писать через temp + fsync + rename, не используя имя загрузки как путь
- [x] добавить admin endpoints загрузки/списка/удаления источника только у draft
  и дедупликацию одинакового содержимого
- [x] сделать published artifacts immutable и безопасно очищать только временные
  или неиспользуемые failed artifacts
- [x] расширить `scripts/backup.ts` консистентным копированием catalog artifacts и
  manifest-проверкой, не затрагивая исходники
- [x] написать тесты multipart limits, поддельной сигнатуры, path traversal,
  дубля, атомарности при сбое, immutable publication и backup/restore layout
- [x] запустить `npx vitest run tests/course-artifacts.test.ts tests/admin-course-sources-routes.test.ts tests/backup.test.ts` и `npm run typecheck`

### Task 10: Реализовать перезапускаемый OCR-конвейер

- [x] реализовать подменяемый `server/ocr-runner.ts` для OCRmyPDF/Tesseract,
  Poppler и qpdf с timeout, output limit, `rus+eng`, deskew/rotate и понятной
  диагностикой отсутствующих зависимостей
- [x] реализовать `server/catalog-worker.ts`: persistent jobs, один OCR одновременно,
  page-level checkpoints, retry диапазона, recovery `running` после рестарта и
  корректный shutdown дочернего процесса
- [x] сохранять распознанный текст и оптимизированные изображения страниц
  атомарно; отмечать страницы с пустым/подозрительно коротким OCR
- [x] подключить worker к lifecycle `buildServer`, административным retry/status
  endpoints и отдельному состоянию catalog/OCR в `/api/health`
- [x] добавить unit-тесты через fake binaries для успеха, timeout, bad output,
  частичного отказа, рестарта, retry и остановки
- [x] добавить маленький русский scan fixture и opt-in `npm run test:ocr`, не
  делая внешние бинарники зависимостью обычного `npm test`
- [x] запустить `npx vitest run tests/ocr-runner.test.ts tests/catalog-worker.test.ts tests/health.test.ts` и `npm run typecheck`

### Task 11: Построить темы и задания по OCR-источникам

- [ ] расширить `CodexRequest`/`codexArgs` в `server/codex/client.ts` безопасным
  массивом `images`, лимитами числа/размера и повторяемым `--image`
- [ ] реализовать полнотекстовый индекс страниц и retrieval по topic/source refs
  с ограниченным числом фрагментов и изображений
- [ ] реализовать асинхронную сборку draft curriculum из OCR-пакетов с
  промежуточными конспектами, строгой JSON schema и сохранением page references
- [ ] расширить `Topic`/промпты генерации, валидации и learning material
  динамическими title/grade и source context; всё OCR-содержимое проводить через
  `dataBlock`
- [ ] запретить публикацию draft с незавершёнными источниками, неизвестными
  page refs или негодным графом; ручной курс без PDF оставить допустимым
- [ ] написать тесты image args, prompt injection из OCR, retrieval limits,
  пакетной сборки, повторов Codex, source refs и ручного курса без PDF
- [ ] запустить `npx vitest run tests/codex-client.test.ts tests/course-drafting.test.ts tests/course-retrieval.test.ts tests/codex-prompt.test.ts tests/codex-generate.test.ts tests/codex-learning-material.test.ts` и `npm run typecheck`

### Task 12: Добавить каталог курсов в админский UI

- [ ] расширить `web/src/admin-api.ts` типами и вызовами courses/drafts/sources,
  не вводя закрытых union по предметам
- [ ] добавить навигацию и экраны списка, создания курса, метаданных и редакций
  в `web/src/admin/AdminApp.tsx`
- [ ] реализовать ручной редактор тем/зависимостей и preview страниц-оснований с
  явным различием draft/published/archived
- [ ] реализовать upload PDF, прогресс OCR/drafting, диагностику страниц,
  retry и блокировку публикации до готовности
- [ ] добавить подтверждение publish/archive и корректно обрабатывать 401, 409,
  сетевой отказ и повторный запрос
- [ ] написать Testing Library тесты всех состояний, конфликтов и недоступности;
  обновить CSS без предметно-зависимых селекторов
- [ ] запустить `npx vitest run web/src/admin/AdminApp.test.tsx web/src/admin/AdminCoursesScreen.test.tsx web/src/admin/AdminCourseEditor.test.tsx web/src/admin-api.test.ts` и `npm run typecheck` и `npm run build:web`

### Task 13: Добавить назначения родителю и динамические карточки ученику

- [ ] расширить `web/src/family-api.ts` каталогом, назначениями и исключениями;
  добавить в `FamilyScreen` настройку курса для каждого ребёнка
- [ ] сделать «все темы» состоянием по умолчанию, раскрывать опциональный список
  исключений и предупреждать, что снятие курса не удаляет прогресс
- [ ] удалить `web/src/subject-meta.ts` и закрытые Subject union; отображать
  title/grade из API, инициалы и детерминированный цвет по course ID
- [ ] обновить `HomeScreen`, `ParentsScreen`, триаж и прогноз для динамического
  количества курсов и пустого состояния без назначений
- [ ] проверить адаптивную раскладку при одном, трёх и большом числе карточек без
  предположения «ровно три»
- [ ] написать Testing Library тесты родительских назначений, новых тем,
  исключений, пустого состояния и произвольных кириллических названий
- [ ] запустить `npx vitest run web/src/FamilyScreen.test.tsx web/src/HomeScreen.test.tsx web/src/ParentsScreen.test.tsx web/src/api.test.ts` и `npm run typecheck` и `npm run build:web`

### Task 14: Подготовить Linux VPS и усилить deploy preflight

- [ ] добавить явный идемпотентный root-скрипт установки OCRmyPDF, Tesseract
  `rus+eng`, Poppler и qpdf для поддерживаемого дистрибутива edukator.ru
- [ ] добавить read-only проверку бинарников, минимальных версий и языковых
  пакетов в удалённый preflight `deploy.sh` до упаковки/остановки сервиса
- [ ] не выполнять `apt install` из обычного deploy; вывести точную команду
  подготовки хоста при отсутствии зависимости
- [ ] добавить maintenance-marker для первого старта мигрирующего релиза: до
  успешного health разрешены диагностика и миграции, но запрещены пользовательские
  записи
- [ ] при неуспешном health останавливать новую версию, восстанавливать полный
  predeploy snapshot баз и catalog artifacts и лишь затем запускать прежний код
- [ ] обновить shell-тесты успешного preflight, каждого отсутствующего пакета,
  отсутствующего `rus/eng`, maintenance-окна, полного restore и отсутствия утечки
  proxy/путей в вывод
- [ ] проверить, что отказ OCR после старта деградирует только catalog worker, а
  занятия по опубликованным курсам и rollback приложения остаются рабочими
- [ ] запустить `npx vitest run tests/deploy-release.test.ts tests/health.test.ts tests/run-child.test.ts` и `npm run lint`

### Task 15: Провести сквозную миграцию и автоматическую приёмку

- [ ] добавить e2e harness для произвольного курса и управляемого OCR/Codex,
  создаваемого во время теста без нового файла в `content/curriculum`
- [ ] реализовать Playwright-сценарий «География, 5 класс»: upload scan → OCR →
  draft → publish → parent assignment/exclusion → triage → обычный run
- [ ] расширить сценарий новой редакцией: новая тема включается, исключение и
  прогресс сохраняются, начатый на старой редакции run завершается
- [ ] прогнать миграционную фикстуру существующей семьи и доказать, что три
  legacy-курса назначены, попытки/прогнозы/банк не изменились, bootstrap повторяем
- [ ] добавить новые server/UI модули в пофайловые пороги `vitest.config.ts` и
  доказать покрытие не ниже принятого проектом 80%
- [ ] проверить edge cases: corrupted PDF, OCR restart, publish conflict,
  archive assigned course, no assignments и отказ одного tenant/source
- [ ] запустить `npm test`, `npm run coverage`, `npm run typecheck`, `npm run lint`,
  `npm run build:web` и `npm run test:e2e`; исправить все ошибки и пороги

### Task 16: Обновить документацию и эксплуатационные инструкции

- [ ] обновить `README.md`: модель курсов, роли, API, каталог артефактов,
  OCR/drafting, назначения, backup и команды проверки
- [ ] обновить `CLAUDE.md`: новые границы `CurriculumProvider`, схемы,
  инварианты редакций, catalog worker и обязательные тестовые гейты
- [ ] документировать миграцию, объём диска, очистку failed/temp artifacts,
  ручной OCR smoke и диагностику health/admin UI
- [ ] сверить документацию с фактическими именами маршрутов, переменных, команд и
  файлов; удалить устаревшие заявления про три предмета и фиксированный 7 класс
- [ ] проверить `git diff --check` и отсутствие незапланированных файлов/секретов

## Technical Details

### Базовые контракты

- `CourseId` — непустая серверно-сгенерированная строка; legacy ID остаются
  валидны, а `overall` зарезервирован для общего прогноза. Display title/grade
  никогда не используются как ключ.
- Существующее поле `subject` в строках и API означает `CourseId`, чтобы не
  переписывать историю ради терминологии.
- `CurriculumSnapshot` содержит revision IDs, `courses` metadata и персональный
  `TopicGraph`; один запрос не смешивает поколения снимка.
- Run хранит `course_revision_id`; старое nullable-значение разрешается через
  legacy revision только при миграционной совместимости.
- Исключения хранятся отрицательным списком. Новая тема включается автоматически.
- Опубликованная редакция и её source artifacts неизменяемы.

### Предлагаемые HTTP-группы

- `/api/admin/courses` — список/создание курса;
- `/api/admin/courses/:courseId` — карточка, метаданные, archive;
- `/api/admin/courses/:courseId/draft` и `/topics` — draft/revision editor;
- `/api/admin/courses/:courseId/sources` — upload/status/retry;
- `/api/admin/courses/:courseId/publish` — атомарная публикация;
- `/api/family/courses` — доступный опубликованный каталог;
- `/api/family/children/:childId/courses/:courseId` — назначение и исключения.

Точные методы и payload фиксируются тестами маршрутов. Все mutation endpoints
должны быть повторяемыми либо иметь явный optimistic conflict.

### OCR и файлы

- Рабочий каталог находится только под `EDUKATOR_DATA_DIR`; серверные IDs задают
  сегменты пути, пользовательские имена хранятся как metadata.
- OCR commands инъецируются интерфейсом runner для unit-тестов.
- Одновременно работает один OCR job; Codex drafting использует существующий
  процессный concurrency budget, но отдельный административный счётчик.
- Полный текст индексируется по course/revision/source/page. В генерацию идут
  только ограниченные excerpts и page images.
- `npm run test:ocr` — opt-in интеграция; deploy preflight — обязательная
  проверка production-зависимостей.

## Success Criteria

Новый курс любого названия и класса создаётся, публикуется, назначается и
используется без изменения кода или файлов репозитория. Ребёнок никогда не видит
неназначенные/исключённые темы. Все старые данные сохранены, новые темы редакции
подхватываются автоматически, активные занятия завершаются на закреплённой
редакции. OCR сканов работает перезапускаемо на edukator.ru, его отказ не
останавливает существующее обучение. Все обязательные проверки проекта зелёные.

## Post-Completion

**Подготовка production:** явно запустить root-скрипт установки OCR-зависимостей
на `edukator.ru`, затем проверить версии, языки `rus/eng`, свободное место и
`npm run test:ocr` на небольшом скане.

**Безопасный rollout:** снять и проверить backup, выполнить deploy, дождаться
legacy-bootstrap и миграции первой детской базы, проверить `/api/health`,
админский каталог, существующую семью и один новый тестовый курс. Сохранить
предыдущий release и backup до завершения проверки больших PDF.

**Наблюдение:** контролировать очередь OCR, время/память на страницу, рост
catalog artifacts, административный расход Codex и failure log. По результатам
реальных учебников скорректировать только конфигурируемые лимиты, не формат
каталога.
