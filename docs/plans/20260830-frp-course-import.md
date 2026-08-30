# Массовый импорт курсов из ФРП — план реализации

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-SKILL: используйте
> `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans` и выполняйте план по задачам. Шаги отмечены
> чекбоксами (`- [ ]`).

**Цель:** завести в каталоге едукатора курсы 5–11 классов по десяти предметам,
состав тем которых происходит из федеральных рабочих программ, а не из чужих
учебников.

**Архитектура:** документ ФРП издан на уровень образования и внутри делится на
учебные курсы и классы. Скрипт режет его на куски «предмет + класс», грузит кусок
как обычный PDF-источник курса через админский HTTP API и дальше пользуется штатным
конвейером каталога (OCR → `buildCourseDraft` → publish). Второго пути сборки карты
тем не заводится. Публикация автоматическая, непубликуемое отсекается пятью
машинными проверками.

**Стек:** TypeScript ESM, tsx, vitest, better-sqlite3, Fastify (сервер — уже есть),
внешние `pdftotext` (poppler) и `qpdf` через `runChild`.

**Спека:** `docs/superpowers/specs/2026-08-30-frp-course-import-design.md`

## Общие ограничения

- Все комментарии, тексты ошибок и названия тестов — по-русски. Комментарий
  объясняет *почему*, а не *что*.
- Относительные импорты пишутся с `.js`, типы импортируются через `import type`,
  необязательное поле добавляется спредом (`exactOptionalPropertyTypes`), после
  индексации нужен `?? ''` или явная проверка (`noUncheckedIndexedAccess`).
- `scripts/*.ts` могут импортировать из `server/`, обратное направление запрещено.
- Внешние процессы запускаются только через `runChild` (`server/run-child.ts`) с
  положительным `timeoutMs`, никогда через `spawn` напрямую.
- Границы слов в регулярных выражениях пишутся `(?!\p{L})`: `\b` в JS только ASCII
  и на кириллице не срабатывает никогда.
- Секреты не принимаются флагами командной строки: пароль читается со stdin через
  `createSecretReader` (`scripts/secret-input.ts`).
- Отметки времени только ISO (`toISOString`).
- Калибровочные константы: `MIN_IMPORT_TOPICS = 8`, `MIN_IMPORT_COVERAGE = 0.6`,
  `MIN_KEPT_TOPIC_IDS = 0.5`. У каждой обязан быть тест с числом, вписанным руками.
- Отказ одного курса не отменяет прогон: он попадает в `failed[]` и доносится кодом
  возврата.
- Перед коммитом чисты `npm test`, `npm run coverage`, `npm run typecheck`,
  `npm run lint`, `npm run build:web`. Задача 1 меняет харнессы, поэтому для неё
  обязателен ещё `npm run test:e2e`.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `scripts/frp-outline.ts` | чистая эвристика: страницы текста → отрезки «учебный курс + класс». Без ввода-вывода |
| `scripts/frp-manifest.ts` | чтение и проверка `content/frp/sources.json` |
| `content/frp/sources.json` | сам манифест программ (данные, не код) |
| `scripts/frp-pdf.ts` | обвязка `pdftotext` и `qpdf` через `runChild` |
| `scripts/admin-client.ts` | HTTP-клиент админского API: вход, курсы, черновики, источники, сборка, публикация |
| `scripts/frp-review.ts` | пять машинных проверок черновика перед публикацией |
| `scripts/import-frp.ts` | оркестратор прогона: CLI, порядок шагов, идемпотентность, `failed[]` |
| `server/course-catalog.ts` | из `bootstrapLegacyCourses` убирается назначение курсов |
| `tests/server-harness.ts`, `e2e/harness.ts` | явное назначение курсов вместо побочного эффекта bootstrap |

---

### Задача 1: снять безусловное назначение курсов при старте

Идёт первой намеренно: она широко правит харнессы, и совмещённая с импортом дала бы
красный тест с двумя причинами сразу.

**Файлы:**
- Изменить: `server/course-catalog.ts:668-724` (`bootstrapLegacyCourses`)
- Изменить: `tests/server-harness.ts:239-242`
- Изменить: `e2e/harness.ts:600-603`
- Тест: `tests/course-catalog.test.ts`

**Интерфейсы:**
- Производит: `bootstrapLegacyCourses(db, curriculumDir?) => { created: CourseId[]; skipped: CourseId[] }` —
  сигнатура не меняется, исчезает только побочный эффект назначения.

- [ ] **Шаг 1: написать падающий тест**

В `tests/course-catalog.test.ts`:

```ts
it('заведение legacy-курсов не назначает их ребёнку', () => {
  const control = openControlDatabase(controlDatabasePath(dir));
  const parentId = createParent(control, { email: 'мама@пример.рф' }).id;
  const childId = createChild(control, { parentId, name: 'Ребёнок' }).id;

  bootstrapLegacyCourses(control, CURRICULUM_DIR);

  const assigned = control
    .prepare<[string], { course_id: string }>(
      'SELECT course_id FROM child_courses WHERE child_id = ? AND unassigned_at IS NULL',
    )
    .all(childId);
  expect(assigned).toEqual([]);
});

it('повторное заведение не возвращает снятый родителем курс', () => {
  const control = openControlDatabase(controlDatabasePath(dir));
  const parentId = createParent(control, { email: 'мама@пример.рф' }).id;
  const childId = createChild(control, { parentId, name: 'Ребёнок' }).id;
  bootstrapLegacyCourses(control, CURRICULUM_DIR);
  assignCourseWithExclusions(control, childId, 'math', [], new Date());
  unassignCourse(control, childId, 'math', new Date());

  bootstrapLegacyCourses(control, CURRICULUM_DIR);

  const active = control
    .prepare<[string], { course_id: string }>(
      "SELECT course_id FROM child_courses WHERE child_id = ? AND course_id = 'math' AND unassigned_at IS NULL",
    )
    .all(childId);
  expect(active).toEqual([]);
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запуск: `npx vitest run tests/course-catalog.test.ts`
Ожидание: первый тест падает — `assigned` содержит `math`, `russian`, `english`.

- [ ] **Шаг 3: убрать назначающую половину**

В `server/course-catalog.ts` из `bootstrapLegacyCourses` удаляются блок выборки
`children`, подготовленный `INSERT INTO child_courses`, цикл по детям, множество
`assignedChildren` и следующий за транзакцией цикл `invalidateChildCurriculum`.
Остаётся только заведение курсов и `return { created, skipped }`.

На месте удалённого блока — комментарий с причиной:

```ts
// Курсы здесь только заводятся. Назначать их ребёнку при старте нельзя:
// класса у `children` нет вовсе, а курсов теперь шестьдесят — пятикласснику
// доставалась бы математика 7 класса. Хуже того, назначение переигрывалось
// каждым стартом, то есть снять курс с ребёнка было невозможно в принципе.
// Назначение — родительское действие, `assignCourseWithExclusions`.
```

- [ ] **Шаг 4: проверить, что тесты проходят**

Запуск: `npx vitest run tests/course-catalog.test.ts`
Ожидание: PASS.

- [ ] **Шаг 5: починить харнессы**

В `tests/server-harness.ts` вызов `bootstrapLegacyCourses` на строке 242 заменяется
явным назначением, а комментарий выше него — новым:

```ts
// Курсы назначаются явно: заведение курсов их больше не назначает, и
// побочный эффект bootstrap, на который харнесс опирался раньше, исчез.
for (const course of listCourses(control)) {
  assignCourseWithExclusions(control, child.childId, course.id, [], new Date());
}
```

Тот же приём в `e2e/harness.ts` на строке 603.

- [ ] **Шаг 6: прогнать всё и починить упавшее**

Запуск: `npm test`, затем `npm run test:e2e`
Ожидание: PASS. Тесты, которые ожидали назначения как побочного эффекта
(`tests/db.test.ts`, `tests/course-assignments.test.ts`), назначают курс явно тем же
`assignCourseWithExclusions`.

- [ ] **Шаг 7: коммит**

```bash
git add server/course-catalog.ts tests/ e2e/
git commit -m "fix: заведение legacy-курсов больше не назначает их детям"
```

---

### Задача 2: нарезка документа ФРП на отрезки «учебный курс + класс»

**Файлы:**
- Создать: `scripts/frp-outline.ts`
- Тест: `tests/frp-outline.test.ts`

**Интерфейсы:**
- Производит:
  ```ts
  export interface FrpPage { num: number; text: string }
  export interface PageRange { from: number; to: number }
  export interface FrpSlice { courseTitle: string; grade: number; ranges: PageRange[] }
  export function sliceFrp(pages: readonly FrpPage[]): FrpSlice[]
  export function rangesForGrade(slices: readonly FrpSlice[], grade: number): PageRange[]
  ```

- [ ] **Шаг 1: написать падающий тест**

`tests/frp-outline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rangesForGrade, sliceFrp, type FrpPage } from '../scripts/frp-outline.js';

function pages(...texts: string[]): FrpPage[] {
  return texts.map((text, index) => ({ num: index + 1, text }));
}

describe('sliceFrp', () => {
  it('разбирает два учебных курса с общими классами', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nЧисла и вычисления',
      'ПРЕДМЕТНЫЕ РЕЗУЛЬТАТЫ\nвыпускник научится',
      'ТЕМАТИЧЕСКОЕ ПЛАНИРОВАНИЕ\n7 КЛАСС\nЧисла и вычисления, 25 часов',
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «ГЕОМЕТРИЯ»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nТреугольники',
    ));

    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 2 }, { from: 4, to: 4 }] },
      { courseTitle: 'ГЕОМЕТРИЯ', grade: 7, ranges: [{ from: 6, to: 6 }] },
    ]);
  });

  it('не берёт страницы вне содержания обучения и тематического планирования', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'ПЛАНИРУЕМЫЕ РЕЗУЛЬТАТЫ\n7 КЛАСС\nличностные результаты',
    ));
    expect(slices).toEqual([]);
  });

  it('склеивает смежные страницы одного класса в один диапазон', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nЧисла',
      'продолжение без заголовков',
      'продолжение без заголовков',
    ));
    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 4 }] },
    ]);
  });

  it('страница со сменой класса попадает в оба класса', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nЧисла\n8 КЛАСС\nСтепень',
    ));
    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 2 }] },
      { courseTitle: 'АЛГЕБРА', grade: 8, ranges: [{ from: 2, to: 2 }] },
    ]);
  });

  it('находит заголовок класса после кириллической границы слова', () => {
    // `\b` здесь не работает: в JS он ASCII-only и после «КЛАСС» границы не видит,
    // поэтому «7 КЛАССИФИКАЦИЯ» прошла бы за заголовок седьмого класса.
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nтекст',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАССИФИКАЦИЯ\nтекст',
    ));
    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 3 }] },
    ]);
  });

  it('игнорирует класс до первого заголовка учебного курса', () => {
    expect(sliceFrp(pages('СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nтекст'))).toEqual([]);
  });
});

describe('rangesForGrade', () => {
  it('собирает диапазоны всех учебных курсов одного класса по порядку', () => {
    const slices = [
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 3 }] },
      { courseTitle: 'ГЕОМЕТРИЯ', grade: 7, ranges: [{ from: 9, to: 9 }] },
      { courseTitle: 'АЛГЕБРА', grade: 8, ranges: [{ from: 4, to: 5 }] },
    ];
    expect(rangesForGrade(slices, 7)).toEqual([{ from: 2, to: 3 }, { from: 9, to: 9 }]);
  });

  it('на классе без отрезков возвращает пустой список', () => {
    expect(rangesForGrade([], 9)).toEqual([]);
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `npx vitest run tests/frp-outline.test.ts`
Ожидание: FAIL — модуля `scripts/frp-outline.ts` нет.

- [ ] **Шаг 3: реализовать эвристику**

`scripts/frp-outline.ts`:

```ts
/**
 * Разбор структуры федеральной рабочей программы. Модуль чистый: на вход — уже
 * извлечённый постранично текст, на выход — отрезки «учебный курс + класс».
 * Извлечение живёт в `frp-pdf.ts`, чтобы эвристику можно было проверять на
 * синтетике, не таская за собой ни одного PDF, — как у `toc.ts`.
 *
 * Программа издана на уровень образования: 5–9 одним документом. Внутри она
 * делится на учебные курсы («Алгебра», «Геометрия», «Вероятность и статистика»),
 * у каждого свои «Содержание обучения» и «Тематическое планирование», и оба
 * разбиты подзаголовками «N КЛАСС». Состав тем несут только эти два раздела:
 * «Планируемые результаты» говорят о личностных и метапредметных достижениях и
 * для карты тем бесполезны.
 */

export interface FrpPage {
  /** Номер страницы в PDF, с единицы. */
  num: number;
  text: string;
}

export interface PageRange { from: number; to: number }

export interface FrpSlice {
  /** Название учебного курса как оно стоит в заголовке, без кавычек. */
  courseTitle: string;
  grade: number;
  ranges: PageRange[];
}

const COURSE_HEADING = /ФЕДЕРАЛЬНАЯ\s+РАБОЧАЯ\s+ПРОГРАММА\s+УЧЕБНОГО\s+КУРСА\s*«([^»]+)»/gu;
const CONTENT_SECTION = /(СОДЕРЖАНИЕ\s+ОБУЧЕНИЯ|ТЕМАТИЧЕСКОЕ\s+ПЛАНИРОВАНИЕ)(?!\p{L})/gu;
const OTHER_SECTION = /(ПЛАНИРУЕМЫЕ\s+РЕЗУЛЬТАТЫ|ПРЕДМЕТНЫЕ\s+РЕЗУЛЬТАТЫ|ПОЯСНИТЕЛЬНАЯ\s+ЗАПИСКА)(?!\p{L})/gu;
// Граница слова здесь обязана быть `(?!\p{L})`: `\b` в JS считает словом только
// ASCII, поэтому «7 КЛАССИФИКАЦИЯ» прошло бы за заголовок седьмого класса.
const GRADE_HEADING = /(\d{1,2})\s*КЛАСС(?!\p{L})/gu;

interface Marker {
  at: number;
  kind: 'course' | 'content' | 'other' | 'grade';
  value: string;
}

function markers(text: string): Marker[] {
  const found: Marker[] = [];
  for (const [regexp, kind] of [
    [COURSE_HEADING, 'course'],
    [CONTENT_SECTION, 'content'],
    [OTHER_SECTION, 'other'],
    [GRADE_HEADING, 'grade'],
  ] as const) {
    for (const match of text.matchAll(regexp)) {
      found.push({ at: match.index, kind, value: match[1] ?? '' });
    }
  }
  return found.sort((left, right) => left.at - right.at);
}

/**
 * Страница приписывается **каждому** состоянию, действовавшему на ней хоть
 * где-то. Заголовки в программе стоят вверху страницы, но граница классов
 * иногда приходится на середину: приписав такую страницу одному состоянию, мы
 * теряли бы начало следующего класса. Лишняя страница в срезе безвредна,
 * потерянная — нет.
 */
export function sliceFrp(pages: readonly FrpPage[]): FrpSlice[] {
  const collected = new Map<string, { courseTitle: string; grade: number; pages: number[] }>();
  let courseTitle: string | undefined;
  let inContent = false;
  let grade: number | undefined;

  for (const page of pages) {
    const onPage = new Map<string, { courseTitle: string; grade: number }>();
    const remember = (): void => {
      if (courseTitle === undefined || !inContent || grade === undefined) return;
      onPage.set(`${courseTitle}${String(grade)}`, { courseTitle, grade });
    };
    remember();
    for (const marker of markers(page.text)) {
      if (marker.kind === 'course') {
        courseTitle = marker.value;
        inContent = false;
        grade = undefined;
      } else if (marker.kind === 'content') {
        inContent = true;
        grade = undefined;
      } else if (marker.kind === 'other') {
        inContent = false;
        grade = undefined;
      } else {
        grade = Number(marker.value);
      }
      remember();
    }
    for (const [key, state] of onPage) {
      const entry = collected.get(key) ?? { ...state, pages: [] };
      entry.pages.push(page.num);
      collected.set(key, entry);
    }
  }

  return [...collected.values()].map((entry) => ({
    courseTitle: entry.courseTitle,
    grade: entry.grade,
    ranges: toRanges(entry.pages),
  }));
}

function toRanges(numbers: readonly number[]): PageRange[] {
  const ranges: PageRange[] = [];
  for (const num of [...numbers].sort((left, right) => left - right)) {
    const last = ranges.at(-1);
    if (last === undefined) ranges.push({ from: num, to: num });
    else if (num === last.to + 1) last.to = num;
    else if (num !== last.to) ranges.push({ from: num, to: num });
  }
  return ranges;
}

/** Диапазоны всех учебных курсов одного класса, в порядке появления в документе. */
export function rangesForGrade(slices: readonly FrpSlice[], grade: number): PageRange[] {
  return slices.filter((slice) => slice.grade === grade).flatMap((slice) => slice.ranges);
}
```

- [ ] **Шаг 4: проверить, что тесты проходят**

Запуск: `npx vitest run tests/frp-outline.test.ts`
Ожидание: PASS, восемь тестов.

- [ ] **Шаг 5: коммит**

```bash
git add scripts/frp-outline.ts tests/frp-outline.test.ts
git commit -m "feat: нарезка федеральной рабочей программы на отрезки класса"
```

---

### Задача 3: манифест программ

**Файлы:**
- Создать: `scripts/frp-manifest.ts`
- Создать: `content/frp/sources.json`
- Тест: `tests/frp-manifest.test.ts`

**Интерфейсы:**
- Производит:
  ```ts
  export interface FrpSource {
    subject: string; title: string; level: 'ooo' | 'soo';
    url: string; sha256: string; grades: number[];
    courseId?: Record<string, string>;
  }
  export const FRP_MANIFEST_PATH: string
  export function parseFrpManifest(raw: unknown): FrpSource[]
  export function readFrpManifest(path?: string): FrpSource[]
  ```

- [ ] **Шаг 1: написать падающий тест**

`tests/frp-manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseFrpManifest, readFrpManifest } from '../scripts/frp-manifest.js';

const entry = {
  subject: 'matematika', title: 'Математика', level: 'ooo',
  url: 'https://edsoo.ru/wp-content/uploads/2025/07/2025_ooo_frp_matematika-5-9_baza.pdf',
  sha256: 'a'.repeat(64), grades: [5, 6, 7, 8, 9], courseId: { 7: 'math' },
};

describe('parseFrpManifest', () => {
  it('разбирает исправный манифест', () => {
    expect(parseFrpManifest([entry])[0]?.subject).toBe('matematika');
  });

  it('отвергает отпечаток не той длины', () => {
    expect(() => parseFrpManifest([{ ...entry, sha256: 'abc' }])).toThrow(/sha256/u);
  });

  it('отвергает адрес не по https', () => {
    expect(() => parseFrpManifest([{ ...entry, url: 'http://edsoo.ru/x.pdf' }])).toThrow(/https/u);
  });

  it('отвергает класс, которого нет в grades', () => {
    expect(() => parseFrpManifest([{ ...entry, courseId: { 4: 'math' } }])).toThrow(/4/u);
  });

  it('отвергает повтор предмета и уровня', () => {
    expect(() => parseFrpManifest([entry, entry])).toThrow(/matematika/u);
  });

  it('отвергает пустой список классов', () => {
    expect(() => parseFrpManifest([{ ...entry, grades: [], courseId: {} }])).toThrow(/grades/u);
  });
});

describe('readFrpManifest', () => {
  it('читает манифест репозитория и находит десять предметов', () => {
    const subjects = new Set(readFrpManifest().map((source) => source.subject));
    expect(subjects.size).toBe(10);
  });

  it('у каждой записи манифеста классы лежат в 5..11', () => {
    for (const source of readFrpManifest()) {
      for (const grade of source.grades) {
        expect(grade).toBeGreaterThanOrEqual(5);
        expect(grade).toBeLessThanOrEqual(11);
      }
    }
  });

  it('legacy-курсы названы ровно для 7 класса', () => {
    const named = readFrpManifest().flatMap((source) => Object.entries(source.courseId ?? {}));
    expect(named.map(([grade]) => grade)).toEqual(['7', '7', '7']);
    expect(new Set(named.map(([, id]) => id))).toEqual(new Set(['math', 'russian', 'english']));
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `npx vitest run tests/frp-manifest.test.ts`
Ожидание: FAIL — модуля нет.

- [ ] **Шаг 3: реализовать чтение и проверку**

`scripts/frp-manifest.ts` — разбор с явными отказами: `subject` непустой и уникален
в паре с `level`; `level` одно из `ooo`/`soo`; `url` начинается с `https://`;
`sha256` — ровно 64 знака `[0-9a-f]`; `grades` непустой список целых 5..11; ключи
`courseId` — классы из `grades`. `FRP_MANIFEST_PATH` считается от `import.meta.url`
до `content/frp/sources.json`, как `CURRICULUM_DIR` в `server/curriculum.ts`.

Причина строгости выписывается комментарием:

```ts
// Манифест ведётся руками, потому что имена файлов на edsoo.ru нерегулярны:
// у математики `2025_ooo_frp_matematika-5-9_baza.pdf`, у русского языка
// `01_frp_russkij-yazyk_5-9-klassy_itog-na-sajt_1-2.pdf`. Правила сборки URL
// не существует, и выведенное правило ломалось бы молча.
//
// `sha256` делает прогон детерминированным и превращает выход новой редакции
// программы в явный отказ «файл на URL изменился» вместо тихой подмены
// содержания курса.
```

- [ ] **Шаг 4: наполнить манифест**

Ссылки берутся со страницы `https://edsoo.ru/rabochie-programmy/` — раскрывающиеся
разделы ООО и СОО. Берётся базовый уровень. Десять предметов: русский язык,
математика, английский язык, физика, химия, биология, география, информатика,
история, обществознание. У каждого запись уровня ООО и запись уровня СОО, если
предмет есть в 10–11 классах.

Отпечаток считается по-настоящему, а не выдумывается:

```bash
curl -sSL -o /tmp/frp.pdf "<url>" && shasum -a 256 /tmp/frp.pdf
```

Проверенные ссылки для начала (остальные снимаются со страницы тем же порядком):

```
математика ООО   2025_ooo_frp_matematika-5-9_baza.pdf
биология ООО     2025_ooo_frp_biologiya_5-9_baza.pdf
география ООО    2025_ooo_frp_geografiya-5-9.pdf
физика ООО       2025_ooo_frp_fizika-7-9_baz.pdf
история ООО      2025_ooo_frp_istoriya_5-9.pdf
русский язык ООО 01_frp_russkij-yazyk_5-9-klassy_itog-na-sajt_1-2.pdf
```

Все — под `https://edsoo.ru/wp-content/uploads/2025/07/`, кроме русского языка
(`2025/09/`). Классы берутся из самой программы: физика и химия начинаются с 7 и 8
классов, а не с пятого. `courseId` проставляется только для 7 класса математики
(`math`), русского языка (`russian`) и английского языка (`english`).

- [ ] **Шаг 5: проверить, что тесты проходят**

Запуск: `npx vitest run tests/frp-manifest.test.ts`
Ожидание: PASS, включая тест про десять предметов и три legacy-курса.

- [ ] **Шаг 6: коммит**

```bash
git add scripts/frp-manifest.ts content/frp/sources.json tests/frp-manifest.test.ts
git commit -m "feat: манифест федеральных рабочих программ"
```

---

### Задача 4: обвязка pdftotext и qpdf

**Файлы:**
- Создать: `scripts/frp-pdf.ts`
- Тест: `tests/frp-pdf.test.ts`

**Интерфейсы:**
- Потребляет: `runChild` из `server/run-child.js`; `FrpPage`, `PageRange` из
  `scripts/frp-outline.js`
- Производит:
  ```ts
  export interface PdfTools { pdftotext: string; qpdf: string }
  export const DEFAULT_PDF_TOOLS: PdfTools
  export const PDF_TOOL_TIMEOUT_MS: number
  export async function readPdfPages(path: string, tools?: PdfTools): Promise<FrpPage[]>
  export async function cutPdf(input: string, output: string, ranges: readonly PageRange[], tools?: PdfTools): Promise<void>
  ```

- [ ] **Шаг 1: написать падающий тест**

`tests/frp-pdf.test.ts` — заглушки исполняемые, shell-скриптами во временном
каталоге, а не моком `spawn`: только так проверяются коды возврата и argv.

```ts
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cutPdf, readPdfPages } from '../scripts/frp-pdf.js';

let dir: string;

function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'frp-pdf-')); });

describe('readPdfPages', () => {
  it('разбивает вывод pdftotext по переводу страницы', async () => {
    const pdftotext = stub('pdftotext', 'printf "первая\\014 вторая"');
    const pages = await readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' });
    expect(pages).toEqual([{ num: 1, text: 'первая' }, { num: 2, text: ' вторая' }]);
  });

  it('отказ pdftotext доносится, а не глотается', async () => {
    const pdftotext = stub('pdftotext', 'echo "сломался" >&2; exit 3');
    await expect(readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' }))
      .rejects.toThrow(/pdftotext/u);
  });

  it('пустой документ даёт пустой список страниц, а не одну пустую', async () => {
    const pdftotext = stub('pdftotext', 'printf ""');
    expect(await readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' })).toEqual([]);
  });
});

describe('cutPdf', () => {
  it('передаёт qpdf по одному диапазону страниц на отрезок', async () => {
    const log = join(dir, 'argv.txt');
    const qpdf = stub('qpdf', `printf '%s\\n' "$@" > ${log}`);
    await cutPdf(join(dir, 'in.pdf'), join(dir, 'out.pdf'),
      [{ from: 2, to: 3 }, { from: 9, to: 9 }], { pdftotext: 'pdftotext', qpdf });
    const argv = readFileSync(log, 'utf8').trim().split('\n');
    expect(argv[0]).toBe('--empty');
    expect(argv).toContain('2-3');
    expect(argv).toContain('9-9');
    expect(argv.at(-1)).toBe(join(dir, 'out.pdf'));
  });

  it('пустой список диапазонов — отказ, а не пустой PDF', async () => {
    await expect(cutPdf(join(dir, 'in.pdf'), join(dir, 'out.pdf'), []))
      .rejects.toThrow(/диапазон/u);
  });

  it('отказ qpdf доносится с кодом возврата', async () => {
    const qpdf = stub('qpdf', 'echo "битый PDF" >&2; exit 2');
    await expect(cutPdf(join(dir, 'in.pdf'), join(dir, 'out.pdf'), [{ from: 1, to: 1 }],
      { pdftotext: 'pdftotext', qpdf })).rejects.toThrow(/qpdf/u);
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `npx vitest run tests/frp-pdf.test.ts`
Ожидание: FAIL — модуля нет.

- [ ] **Шаг 3: реализовать обвязку**

`scripts/frp-pdf.ts`. `readPdfPages` зовёт `pdftotext -layout <path> -` и режет
stdout по знаку перевода страницы (``), нумеруя куски с единицы; пустой вывод
даёт пустой список. `cutPdf` собирает argv
`['--empty', '--pages', input, '2-3', input, '9-9', '--', output]`.

Оба вызова идут через `runChild` с `timeoutMs: PDF_TOOL_TIMEOUT_MS` и
`maxOutputBytes`; ненулевой код возврата превращается в ошибку, называющую
инструмент и stderr.

Пустой список диапазонов отвергается, и причина выписывается:

```ts
// `qpdf --empty` без страниц выдаёт пустой PDF, который дальше прошёл бы
// конвейер как «источник без распознанных страниц»: отказ приехал бы с другого
// конца, с другой причиной и уже после OCR.
```

- [ ] **Шаг 4: проверить, что тесты проходят**

Запуск: `npx vitest run tests/frp-pdf.test.ts`
Ожидание: PASS, шесть тестов.

- [ ] **Шаг 5: коммит**

```bash
git add scripts/frp-pdf.ts tests/frp-pdf.test.ts
git commit -m "feat: обвязка pdftotext и qpdf для нарезки программ"
```

---

### Задача 5: HTTP-клиент админского API

**Файлы:**
- Создать: `scripts/admin-client.ts`
- Тест: `tests/admin-client.test.ts`

**Интерфейсы:**
- Потребляет: `CatalogRevisionTopic` из `server/course-catalog.js`
- Производит:
  ```ts
  export interface AdminClient {
    login(email: string, password: string): Promise<void>;
    listCourses(): Promise<Array<{ id: string; title: string; grade: string; activeRevisionId: number | null }>>;
    createCourse(input: { id?: string; title: string; grade: string }): Promise<{ course: { id: string }; draft: { id: number; editVersion: number } }>;
    readDraft(courseId: string): Promise<{ revision: { id: number; editVersion: number }; topics: CatalogRevisionTopic[] } | undefined>;
    createDraft(courseId: string, activeRevisionId: number): Promise<{ revision: { id: number; editVersion: number } }>;
    uploadSource(courseId: string, filePath: string): Promise<{ source: { id: number; revisionId: number }; duplicate: boolean }>;
    sourceStatus(courseId: string, sourceId: number): Promise<{ status: string; pages?: number }>;
    startBuild(courseId: string, revisionId: number, editVersion: number): Promise<void>;
    buildStatus(courseId: string): Promise<{ revisionId: number; job: { status: string; error: string | null } | null }>;
    publish(courseId: string, revisionId: number, editVersion: number, idempotencyKey: string): Promise<{ idempotent?: boolean }>;
  }
  export function createAdminClient(baseUrl: string, fetchImpl?: typeof fetch): AdminClient
  ```

- [ ] **Шаг 1: написать падающий тест**

`tests/admin-client.test.ts` — против подменённого `fetch`, живой сети нет:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAdminClient } from '../scripts/admin-client.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as unknown as typeof fetch;
}

const loggedIn = new Response('{}', {
  status: 200, headers: { 'set-cookie': '__Host-edu_admin=токен; Path=/' },
});

describe('createAdminClient', () => {
  it('шлёт Origin на изменяющем запросе: браузерных заголовков у скрипта нет', async () => {
    let seen: string | undefined;
    const client = createAdminClient('https://edukator.ru', fakeFetch((_url, init) => {
      seen = new Headers(init.headers).get('origin') ?? undefined;
      return loggedIn.clone();
    }));
    await client.login('оператор@пример.рф', 'пароль-подлиннее-и-ещё');
    expect(seen).toBe('https://edukator.ru');
  });

  it('несёт cookie входа в следующий запрос', async () => {
    let cookie: string | undefined;
    const client = createAdminClient('https://edukator.ru', fakeFetch((url, init) => {
      if (url.endsWith('/api/auth/admin/login')) return loggedIn.clone();
      cookie = new Headers(init.headers).get('cookie') ?? undefined;
      return new Response(JSON.stringify({ courses: [] }), { status: 200 });
    }));
    await client.login('оператор@пример.рф', 'пароль-подлиннее-и-ещё');
    await client.listCourses();
    expect(cookie).toContain('__Host-edu_admin=токен');
  });

  it('вход без Set-Cookie — отказ, а не молчаливый успех', async () => {
    const client = createAdminClient('https://edukator.ru',
      fakeFetch(() => new Response('{}', { status: 200 })));
    await expect(client.login('оператор@пример.рф', 'пароль')).rejects.toThrow(/cookie/u);
  });

  it('403 называет причину из тела, а не «не удалось»', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ error: 'read-only' }), { status: 403 })));
    await client.login('оператор@пример.рф', 'пароль');
    await expect(client.listCourses()).rejects.toThrow(/read-only/u);
  });

  it('publish отвечает idempotent на уже опубликованной редакции', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ revision: { id: 3 }, idempotent: true }), { status: 200 })));
    await client.login('оператор@пример.рф', 'пароль');
    expect((await client.publish('math', 3, 1, 'ключ')).idempotent).toBe(true);
  });

  it('readDraft на курсе без черновика возвращает undefined, а не бросает', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ error: 'нет черновика' }), { status: 404 })));
    await client.login('оператор@пример.рф', 'пароль');
    expect(await client.readDraft('math')).toBeUndefined();
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `npx vitest run tests/admin-client.test.ts`
Ожидание: FAIL — модуля нет.

- [ ] **Шаг 3: реализовать клиент**

`scripts/admin-client.ts`. Один приватный `request(method, path, body?)`: ставит
`Origin: <baseUrl>` на каждый запрос, несёт cookie `__Host-edu_admin`, разбирает
JSON, а ненулевой статус превращает в ошибку с полем `error` из тела. `readDraft`
отдельно переводит 404 в `undefined`: «у курса нет черновика» — это состояние, а не
поломка. Загрузка источника — `multipart/form-data` через `FormData` и `Blob` с
типом `application/pdf`.

Причина отдельного заголовка выписывается комментарием:

```ts
// Изменяющие запросы сверяют источник целиком, схему вместе с хостом, и без
// `Origin` каждый POST вернёт 403: браузерных заголовков у скрипта нет.
```

- [ ] **Шаг 4: проверить, что тесты проходят**

Запуск: `npx vitest run tests/admin-client.test.ts`
Ожидание: PASS, шесть тестов.

- [ ] **Шаг 5: коммит**

```bash
git add scripts/admin-client.ts tests/admin-client.test.ts
git commit -m "feat: HTTP-клиент админского API каталога"
```

---

### Задача 6: машинная отбраковка черновика

**Файлы:**
- Создать: `scripts/frp-review.ts`
- Тест: `tests/frp-review.test.ts`

**Интерфейсы:**
- Потребляет: `buildTopicGraph` из `server/curriculum.js`, `CatalogRevisionTopic`
  из `server/course-catalog.js`
- Производит:
  ```ts
  export const MIN_IMPORT_TOPICS = 8;
  export const MIN_IMPORT_COVERAGE = 0.6;
  export const MIN_KEPT_TOPIC_IDS = 0.5;
  export interface ReviewInput {
    courseId: string;
    topics: readonly CatalogRevisionTopic[];
    source: { id: number; pages: number };
    previousTopicIds?: readonly string[];
  }
  export interface ReviewResult {
    ok: boolean; problems: string[]; coverage: number; keptRatio: number | undefined;
  }
  export function reviewDraft(input: ReviewInput): ReviewResult
  ```

- [ ] **Шаг 1: написать падающий тест**

`tests/frp-review.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MIN_IMPORT_COVERAGE, MIN_IMPORT_TOPICS, MIN_KEPT_TOPIC_IDS, reviewDraft,
} from '../scripts/frp-review.js';
import type { CatalogRevisionTopic } from '../server/course-catalog.js';

function topic(index: number, overrides: Partial<CatalogRevisionTopic> = {}): CatalogRevisionTopic {
  return {
    id: `topic-${String(index)}`, title: `Тема ${String(index)}`,
    examWeight: 2, difficulty: 2, prereqs: [], answerFormat: 'number',
    promptSeed: 'Генерируй задания', active: true, position: index,
    sourceRefs: [{ sourceId: 1, pageFrom: index, pageTo: index }],
    ...overrides,
  };
}

const source = { id: 1, pages: 10 };
const ten = (): CatalogRevisionTopic[] => Array.from({ length: 10 }, (_, i) => topic(i + 1));

describe('reviewDraft', () => {
  it('пропускает исправный черновик', () => {
    expect(reviewDraft({ courseId: 'geo-5', topics: ten(), source }).ok).toBe(true);
  });

  it('бракует черновик, где тем меньше порога', () => {
    const topics = Array.from({ length: MIN_IMPORT_TOPICS - 1 }, (_, i) => topic(i + 1));
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/тем/u);
  });

  it('бракует ссылку за границу источника', () => {
    const topics = ten();
    topics[0] = topic(1, { sourceRefs: [{ sourceId: 1, pageFrom: 1, pageTo: 99 }] });
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/страниц/u);
  });

  it('бракует ссылку на чужой источник', () => {
    const topics = ten();
    topics[0] = topic(1, { sourceRefs: [{ sourceId: 42, pageFrom: 1, pageTo: 1 }] });
    expect(reviewDraft({ courseId: 'geo-5', topics, source }).ok).toBe(false);
  });

  it('бракует тему вовсе без ссылок на страницы', () => {
    const topics = ten();
    topics[0] = topic(1, { sourceRefs: [] });
    expect(reviewDraft({ courseId: 'geo-5', topics, source }).ok).toBe(false);
  });

  it('бракует низкое покрытие куска', () => {
    // Десять тем, но все ссылаются на одну страницу из десяти: модель прочитала
    // начало и досочинила остальное.
    const topics = Array.from({ length: 10 }, (_, i) =>
      topic(i + 1, { sourceRefs: [{ sourceId: 1, pageFrom: 1, pageTo: 1 }] }));
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeLessThan(MIN_IMPORT_COVERAGE);
  });

  it('бракует цикл в prereqs до публикации, а не после', () => {
    const topics = ten();
    topics[0] = topic(1, { prereqs: ['topic-2'] });
    topics[1] = topic(2, { prereqs: ['topic-1'] });
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/цикл/u);
  });

  it('бракует потерю накопленного прогресса на legacy-курсе', () => {
    const previousTopicIds = Array.from({ length: 20 }, (_, i) => `старая-${String(i)}`);
    const result = reviewDraft({ courseId: 'math', topics: ten(), source, previousTopicIds });
    expect(result.ok).toBe(false);
    expect(result.keptRatio).toBeLessThan(MIN_KEPT_TOPIC_IDS);
  });

  it('на новом курсе доля сохранённых тем не считается вовсе', () => {
    expect(reviewDraft({ courseId: 'geo-5', topics: ten(), source }).keptRatio).toBeUndefined();
  });

  it('называет все причины разом, а не первую', () => {
    const topics = [topic(1, { sourceRefs: [{ sourceId: 42, pageFrom: 1, pageTo: 1 }] })];
    expect(reviewDraft({ courseId: 'geo-5', topics, source }).problems.length).toBeGreaterThan(1);
  });

  it('держит калибровочные константы спеки', () => {
    expect(MIN_IMPORT_TOPICS).toBe(8);
    expect(MIN_IMPORT_COVERAGE).toBe(0.6);
    expect(MIN_KEPT_TOPIC_IDS).toBe(0.5);
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `npx vitest run tests/frp-review.test.ts`
Ожидание: FAIL — модуля нет.

- [ ] **Шаг 3: реализовать пять проверок**

`scripts/frp-review.ts`. Проверки складывают причины в `problems`, а не бросают на
первой: отчёт по курсу обязан назвать всё сразу, иначе разбираться придётся в пять
заходов. `buildTopicGraph` оборачивается `try/catch` — его сообщение и есть причина.

Покрытие — доля страниц источника, попавших хотя бы в один `sourceRef`. `keptRatio`
считается только при переданном `previousTopicIds` и равен доле прежних
идентификаторов, оставшихся среди тем черновика.

Комментарий о том, зачем граф гонится здесь:

```ts
// Граф проверяется до публикации намеренно. `buildTopicGraph` ловит циклы,
// висячие prereqs и предпосылку с недостаточным exam_weight, но зовут его
// провайдер и чтение — то есть опубликованная битая редакция сломалась бы уже
// у ребёнка, на первом же занятии.
```

- [ ] **Шаг 4: проверить, что тесты проходят**

Запуск: `npx vitest run tests/frp-review.test.ts`
Ожидание: PASS, одиннадцать тестов.

- [ ] **Шаг 5: коммит**

```bash
git add scripts/frp-review.ts tests/frp-review.test.ts
git commit -m "feat: машинная отбраковка черновика перед публикацией"
```

---

### Задача 7: оркестратор прогона

**Файлы:**
- Создать: `scripts/import-frp.ts`
- Изменить: `package.json` (команда `import-frp`)
- Изменить: `vitest.config.ts` (порог покрытия новых чистых модулей)
- Изменить: `CLAUDE.md` (команда и раздел структуры)
- Тест: `tests/import-frp.test.ts`

**Интерфейсы:**
- Потребляет: `readFrpManifest`/`FrpSource`, `sliceFrp`/`rangesForGrade`,
  `readPdfPages`/`cutPdf`, `createAdminClient`/`AdminClient`, `reviewDraft`
- Производит:
  ```ts
  export interface ImportOptions {
    client: AdminClient;
    sources: readonly FrpSource[];
    cacheDir: string;
    download: (url: string, target: string) => Promise<void>;
    subject?: string;
    grade?: number;
    dryRun?: boolean;
    log?: (line: string) => void;
  }
  export interface ImportReport {
    published: string[];
    skipped: string[];
    failed: Array<{ course: string; reason: string }>;
  }
  export async function importCourses(options: ImportOptions): Promise<ImportReport>
  ```

- [ ] **Шаг 1: написать падающий тест**

`tests/import-frp.test.ts`. Живой сети и живого сервера нет: скачивание — за
`download`, сервер — за поддельным `AdminClient`, `pdftotext` и `qpdf` — те же
shell-заглушки, что в задаче 4.

```ts
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importCourses, type ImportOptions } from '../scripts/import-frp.js';
import type { AdminClient } from '../scripts/admin-client.js';
import type { FrpSource } from '../scripts/frp-manifest.js';

const DOCUMENT = [
  'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «ГЕОГРАФИЯ»',
  'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n5 КЛАСС\nИстория открытия Земли',
].join('');
const SHA = createHash('sha256').update(DOCUMENT).digest('hex');

const source: FrpSource = {
  subject: 'geografiya', title: 'География', level: 'ooo',
  url: 'https://edsoo.ru/wp-content/uploads/2025/07/2025_ooo_frp_geografiya-5-9.pdf',
  sha256: SHA, grades: [5],
};

interface Calls {
  createCourse: unknown[]; createDraft: unknown[]; uploadSource: unknown[];
  startBuild: unknown[]; publish: unknown[];
}

interface FakeState {
  /** Курс уже опубликован от того же документа. */
  published?: boolean;
  /** Загрузка источника отвечает `duplicate`. */
  duplicate?: boolean;
  /** Сборка черновика заканчивается отказом. */
  buildFails?: boolean;
  /** Черновик собран, но тем в нём меньше порога отбраковки. */
  thinDraft?: boolean;
}

let dir: string;
let calls: Calls;

function fakeClient(state: FakeState = {}): AdminClient {
  const topics = Array.from({ length: state.thinDraft === true ? 2 : 10 }, (_, index) => ({
    id: `topic-${String(index)}`, title: `Тема ${String(index)}`, examWeight: 2,
    difficulty: 2, prereqs: [], answerFormat: 'number' as const,
    promptSeed: 'Генерируй', active: true, position: index,
    sourceRefs: [{ sourceId: 1, pageFrom: index + 1, pageTo: index + 1 }],
  }));
  return {
    login: async () => undefined,
    listCourses: async () => (state.published === true
      ? [{ id: 'geo-5', title: 'География', grade: '5 класс', activeRevisionId: 7 }]
      : []),
    createCourse: async (input) => {
      calls.createCourse.push(input);
      return { course: { id: 'geo-5' }, draft: { id: 1, editVersion: 1 } };
    },
    createDraft: async (courseId, activeRevisionId) => {
      calls.createDraft.push({ courseId, activeRevisionId });
      return { revision: { id: 2, editVersion: 1 } };
    },
    readDraft: async () => ({ revision: { id: 1, editVersion: 1 }, topics }),
    uploadSource: async (courseId, filePath) => {
      calls.uploadSource.push({ courseId, filePath });
      return { source: { id: 1, revisionId: 1 }, duplicate: state.duplicate === true };
    },
    sourceStatus: async () => ({ status: 'ready' }),
    startBuild: async (courseId, revisionId, editVersion) => {
      calls.startBuild.push({ courseId, revisionId, editVersion });
    },
    buildStatus: async () => ({
      revisionId: 1,
      job: state.buildFails === true
        ? { status: 'failed', error: 'модель не ответила' }
        : { status: 'done', error: null },
    }),
    publish: async (courseId, revisionId, editVersion, idempotencyKey) => {
      calls.publish.push({ courseId, revisionId, editVersion, idempotencyKey });
      return {};
    },
  };
}

function options(state: FakeState = {}, overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    client: fakeClient(state),
    sources: [source],
    cacheDir: dir,
    download: async (_url, target) => { writeFileSync(target, DOCUMENT); },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'import-frp-'));
  calls = { createCourse: [], createDraft: [], uploadSource: [], startBuild: [], publish: [] };
});

describe('importCourses', () => {
  it('публикует курс класса из документа уровня', async () => {
    const report = await importCourses(options());
    expect(report.published).toEqual(['geo-5']);
    expect(calls.publish).toHaveLength(1);
  });

  it('отказ одного курса не отменяет остальные', async () => {
    const report = await importCourses(options({ buildFails: true }, {
      sources: [source, { ...source, subject: 'istoriya', title: 'История' }],
    }));
    expect(report.failed).toHaveLength(2);
    expect(report.failed[0]?.reason).toMatch(/модель не ответила/u);
  });

  it('повторный прогон на опубликованном курсе не создаёт ни черновика, ни источника', async () => {
    const report = await importCourses(options({ published: true }));
    expect(report.skipped).toContain('geo-5');
    expect(calls.createDraft).toHaveLength(0);
    expect(calls.uploadSource).toHaveLength(0);
  });

  it('источник, ответивший duplicate, не запускает вторую сборку', async () => {
    await importCourses(options({ duplicate: true }));
    expect(calls.startBuild).toHaveLength(0);
  });

  it('dry-run не делает ни одного изменяющего запроса', async () => {
    const report = await importCourses(options({}, { dryRun: true }));
    expect(calls.createCourse).toHaveLength(0);
    expect(calls.uploadSource).toHaveLength(0);
    expect(calls.publish).toHaveLength(0);
    expect(report.published).toEqual([]);
  });

  it('subject режет прогон', async () => {
    const report = await importCourses(options({}, { subject: 'istoriya' }));
    expect(report.published).toEqual([]);
    expect(calls.createCourse).toHaveLength(0);
  });

  it('несовпадение sha256 отказывает курсу и называет адрес', async () => {
    const report = await importCourses(options({}, {
      download: async (_url, target) => { writeFileSync(target, 'другой документ'); },
    }));
    expect(report.failed[0]?.reason).toMatch(/sha256/u);
    expect(report.failed[0]?.reason).toMatch(/edsoo\.ru/u);
  });

  it('черновик, не прошедший отбраковку, не публикуется', async () => {
    const report = await importCourses(options({ thinDraft: true }));
    expect(calls.publish).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/тем/u);
  });

  it('класс без отрезков в документе отказывает курсу, а не пустым PDF', async () => {
    const report = await importCourses(options({}, {
      sources: [{ ...source, grades: [9] }],
    }));
    expect(calls.uploadSource).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/класс/u);
  });
});
```

Заглушки `pdftotext` и `qpdf` подставляются через `PdfTools` задачи 4: `pdftotext`
печатает содержимое файла как есть (документ в тесте — уже текст со знаком перевода
страницы), `qpdf` копирует вход в выход.

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `npx vitest run tests/import-frp.test.ts`
Ожидание: FAIL — модуля нет.

- [ ] **Шаг 3: реализовать оркестратор**

Порядок на курс — девять шагов спеки: скачать и сверить `sha256` → нарезать кусок →
взять курс из манифеста или создать → открыть черновик → загрузить кусок →
дождаться `ready` источника → запустить сборку и дождаться её → проверить черновик
`reviewDraft` → опубликовать.

Курсы идут строго по одному. Ожидание OCR и сборки — опрос с паузой, оба с
предельным сроком: молчащая очередь не должна держать прогон вечно.

Число страниц куска для `reviewDraft` берётся из самих диапазонов нарезки
(`sum(to - from + 1)`), а не из ответа `sourceStatus`: страницы мы отрезали сами и
знаем их точно, а `pages` там необязательное поле — на его отсутствии покрытие
посчиталось бы от нуля и пропустило бы любой черновик.

Ключевые комментарии:

```ts
// Курсы идут по одному: OCR-очередь на сервере однопоточная, а
// `catalogCodexConcurrency` равен единице — второй поток встал бы в ту же
// очередь, не ускорив ничего.

// Отказ одного курса прогон не отменяет: он уезжает в `failed[]` и доносится
// кодом возврата, как у `backupDataDir` и `prefetchChildren`. Вылет наружу
// оставил бы каталог полусобранным, а остальные предметы — незаведёнными.

// В журнал аварий скрипт не пишет ничего. `LOG_EVENTS` — закрытое объединение,
// и у каждого имени обязано быть место вызова; `backup-failed` и
// `prefetch-failed` там потому, что их зовёт cron и кода возврата не видит
// никто. Импорт запускают руками, каталога данных у него нет вовсе.
```

CLI: `parseAccountArgs` не подходит — он требует `--data-dir`, которого здесь нет
вовсе, потому что скрипт ходит по HTTP. Разбор свой, но запрет секретов во флагах
повторяется дословно: `--password` отвергается с той же формулировкой, пароль
читается `createSecretReader`. Скачанные документы кладутся в `--cache-dir` и
переиспользуются по `sha256`: качать одну программу заново для каждого из пяти её
классов незачем.

- [ ] **Шаг 4: проверить, что тесты проходят**

Запуск: `npx vitest run tests/import-frp.test.ts`
Ожидание: PASS, восемь тестов.

- [ ] **Шаг 5: прописать команду и порог покрытия**

В `package.json`: `"import-frp": "tsx scripts/import-frp.ts"`.

В `vitest.config.ts` рядом с существующими порогами:

```ts
// Чистые модули импорта: эвристика нарезки, разбор манифеста, отбраковка и
// клиент детерминированы и подменяемы целиком. `frp-pdf` и `import-frp`
// завязаны на внешние процессы и живой сервер — для них общий порог был бы
// враньём, как и для `extract-toc`.
'scripts/{frp-outline,frp-manifest,frp-review,admin-client}.ts': {
  statements: 80, branches: 80, functions: 80, lines: 80,
},
```

- [ ] **Шаг 6: обновить CLAUDE.md**

В блок команд — строка:

```sh
npm run import-frp -- --base-url <адрес> --email <оператор>  # курсы 5-11 из ФРП
```

В раздел «Структура» — абзац о том, что состав тем курсов происходит из
федеральных рабочих программ, а импорт ходит по HTTP, потому что каталог данных
держит замок сервера и второй держатель замка при живом сервере невозможен.

- [ ] **Шаг 7: полная проверка и коммит**

Запуск: `npm test`, `npm run coverage`, `npm run typecheck`, `npm run lint`,
`npm run build:web`, `npm run test:e2e`
Ожидание: все шесть чисты.

```bash
git add scripts/import-frp.ts tests/import-frp.test.ts package.json vitest.config.ts CLAUDE.md
git commit -m "feat: массовый импорт курсов 5-11 классов из ФРП"
```

---

## Приёмка

После задачи 7 — прогон на живом сервере:

```bash
npm run import-frp -- --base-url https://edukator.ru --email <оператор> --dry-run
npm run import-frp -- --base-url https://edukator.ru --email <оператор>
```

Ожидается: курсы 5–11 классов по десяти предметам опубликованы; у каждой темы есть
ссылка на страницы внутри своего куска; повторный запуск не создаёт ничего и
завершается нулём; курсы `math`, `russian`, `english` получили новую редакцию, а
назначения и `topic_state` детей целы; ни один старт сервера больше не назначает
курс ребёнку.

Прогон запускается ночью: пока он идёт, один из двух общих слотов codex занят
сборкой карт, и прогрев банка заданий детям идёт вполовину медленнее.
