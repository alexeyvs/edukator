import { expect, test } from '@playwright/test';
import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { E2E_PARENT, startE2eHarness, type E2eHarness, type E2eSide } from './harness.js';

const execFile = promisify(execFileCallback);

async function assertControllerAcceptsGate(gate: unknown): Promise<void> {
  const python = process.env.EDUKATOR_PYTHON ?? 'python3';
  const script = [
    'import json, sys',
    'from edukator_family_controller.gate import parse_gate',
    'parse_gate(json.loads(sys.argv[1]))',
    "print('ok')",
  ].join('; ');
  const { stdout } = await execFile(python, ['-c', script, JSON.stringify(gate)], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: resolve('controller/src') },
  });
  expect(stdout.trim()).toBe('ok');
}

/**
 * Заголовки запроса мимо интерфейса. Оба ставятся руками потому, что
 * `page.request` — не браузер, а узел: cookie с `Secure` он по голому http не
 * несёт, а `Origin` на изменяющем запросе не выставляет, и сервер отказал бы
 * такому запросу как неподтверждённому.
 */
function apiHeaders(harness: E2eHarness, side: E2eSide = 'child'): Record<string, string> {
  return { origin: harness.url, cookie: harness.cookieHeader(side) };
}

/** Стартует забег в обход интерфейса: сам старт проверяют другие сценарии. */
async function startRunDirectly(
  page: import('@playwright/test').Page,
  harness: E2eHarness,
  subject: string,
): Promise<number> {
  const started = await page.request.post(`${harness.url}/api/run/start`, {
    data: { subject },
    headers: apiHeaders(harness),
  });
  expect(started.ok()).toBe(true);
  const { runId } = await started.json() as { runId: number };
  return runId;
}

async function startReadyBoss(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(url);
  const topic = page.locator('.topic-map li').filter({
    has: page.getByText('Тема math 1', { exact: true }),
  });
  await expect(topic).toContainText('Можно вызвать босса');
  await topic.getByRole('button', { name: 'Вызвать босса' }).click();
  await expect(page.getByRole('heading', { name: 'Пять подряд — и тема закрыта' })).toBeVisible();
  await page.getByRole('button', { name: 'Начать бой' }).click();
}

async function answerBoss(page: import('@playwright/test').Page, answer: string): Promise<void> {
  await page.getByLabel('Число').fill(answer);
  await page.getByRole('button', { name: 'Проверить' }).click();
}

async function dragTileWithMouse(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('Карточка не получила координаты для mouse drag');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function dragTileWithTouch(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('Карточка не получила координаты для touch drag');
  const session = await page.context().newCDPSession(page);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const finish = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let step = 1; step <= 8; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: start.x + (finish.x - start.x) * step / 8,
        y: start.y + (finish.y - start.y) * step / 8,
      }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test('главная показывает и открывает незавершённый забег прошлого дня', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'math' });
  try {
    const runId = Number(harness.db.prepare(
      `INSERT INTO runs
         (subject, kind, topic_id, started_at, total, correct, lives_remaining)
       VALUES ('math', 'run', 'math.1', ?, 7, 4, 1)`,
    ).run('2026-08-07T12:00:00.000Z').lastInsertRowid);

    await page.goto(harness.url);
    const card = page.locator('.plan-cards article').filter({ hasText: 'Тема math 1' });
    await expect(card).toContainText('Математика · 7 из 12 · начат вчера');
    await card.getByRole('button', { name: 'Продолжить' }).click();

    await expect(page).toHaveURL(`${harness.url}/?runId=${runId}`);
    await expect(page.getByLabel('Прогресс: 7 из 12')).toBeVisible();
    await expect(page.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
    expect(harness.db.prepare<[number], { finished_at: string | null }>(
      'SELECT finished_at FROM runs WHERE id = ?',
    ).get(runId)).toEqual({ finished_at: null });
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('полный забег из двенадцати заданий приводит на финальный экран', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'math' });
  try {
    await page.goto(harness.url);
    const mathRun = page.locator('.plan-cards article').filter({ hasText: 'Математика' });
    await mathRun.getByRole('button', { name: 'Начать' }).click();

    // Формула посреди инструкции обязана дойти нарисованной: fallback исходника
    // выглядит как рабочий экран, и без явной проверки регресс не виден.
    await expect(page.locator('.task-instruction .task-math-inline .katex')).toBeVisible();
    await expect(page.locator('.task-instruction .task-math-source-inline')).toHaveCount(0);

    for (let answered = 1; answered <= 12; answered += 1) {
      await expect(page.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
      await page.getByLabel('Число').fill('45');
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.locator('.verdict')).toContainText('Верно');
      await page.getByRole('button', {
        name: answered === 12 ? 'Завершить забег' : 'Следующее задание',
      }).click();
    }

    await expect(page.getByRole('heading', { name: 'Вот что получилось' })).toBeVisible();
    await expect(page.locator('.finish-stats')).toContainText('12сделано');
    await expect(page.locator('.finish-stats')).toContainText('12верно');
    expect(harness.db.prepare<[], { kind: string; total: number; correct: number }>(
      'SELECT kind, total, correct FROM runs ORDER BY id DESC LIMIT 1',
    ).get()).toEqual({ kind: 'run', total: 12, correct: 12 });
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('ошибка с исправлением не увеличивает 12 вопросов и приводит на финал', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'math' });
  try {
    const runId = await startRunDirectly(page, harness, 'math');
    await page.goto(`${harness.url}/?runId=${runId}`);

    await expect(page.getByText('Жизни: 3 из 3')).toBeVisible();
    await page.getByLabel('Число').fill('44');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Пока не сошлось');
    await expect(page.getByText('Жизни: 3 из 3')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Я всё-таки прав' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Исправить ответ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Следующее задание' })).toBeVisible();

    await page.getByRole('button', { name: 'Исправить ответ' }).click();
    await expect(page.getByLabel('Число')).toHaveValue('');
    await page.getByLabel('Число').fill('45');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Верно');
    await expect(page.getByText('Жизни: 2 из 3')).toBeVisible();
    await expect(page.getByLabel('Прогресс: 1 из 12')).toBeVisible();

    for (let answered = 2; answered <= 12; answered += 1) {
      await page.getByRole('button', { name: 'Следующее задание' }).click();
      await expect(page.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
      await page.getByLabel('Число').fill('45');
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.locator('.verdict')).toContainText('Верно');
    }
    await page.getByRole('button', { name: 'Завершить забег' }).click();

    await expect(page.getByRole('heading', { name: 'Вот что получилось' })).toBeVisible();
    expect(harness.db.prepare<[number], {
      total: number; correct: number; current_attempts: number; all_attempts: number;
    }>(
      `SELECT runs.total, runs.correct,
              SUM(attempts.is_current) AS current_attempts,
              COUNT(attempts.id) AS all_attempts
         FROM runs JOIN attempts ON attempts.run_id = runs.id
        WHERE runs.id = ? GROUP BY runs.id`,
    ).get(runId)).toEqual({ total: 12, correct: 12, current_attempts: 12, all_attempts: 13 });
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('текстовый ответ проходит обычный забег', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'russian' });
  try {
    const runId = await startRunDirectly(page, harness, 'russian');
    await page.goto(`${harness.url}/?runId=${runId}`);

    await expect(page.getByRole('heading', { name: /Вставь слово/ })).toBeVisible();
    await expect(page.getByLabel('Материал задания')).toContainText('школьный ___');
    await page.getByLabel('Ответ').fill('учебник');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Верно');
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('карточки слов собираются клавиатурой и кнопками и отправляют строку ответа', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'russian' });
  try {
    harness.db.prepare(
      `UPDATE task_bank SET status = 'rejected'
        WHERE topic_id LIKE 'russian.%' AND word_tiles = '[]'`,
    ).run();
    const runId = await startRunDirectly(page, harness, 'russian');
    await page.goto(`${harness.url}/?runId=${runId}`);

    await expect(page.getByRole('heading', { name: /Собери предложение/u })).toBeVisible();
    await expect(page.getByLabel('Ответ')).toHaveCount(0);
    await page.getByRole('button', { name: 'Нужна подсказка' }).click();
    await expect(page.getByText(/Сначала найди подлежащее/u)).toBeVisible();
    await page.getByRole('button', { name: 'Подробнее: теория и примеры' }).click();
    await expect(page.getByRole('complementary', { name: 'Теория и похожие примеры' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Похожий пример/u })).toHaveCount(2);
    const words = page.locator('.word-tile-text');
    const handles = page.getByRole('button', { name: /Перетащить слово/u });
    const beforeMouse = await words.allTextContents();
    await dragTileWithMouse(page, handles.first(), page.locator('.word-tile').last());
    await expect.poll(() => words.allTextContents()).not.toEqual(beforeMouse);

    const beforeTouch = await words.allTextContents();
    await dragTileWithTouch(page, handles.first(), page.locator('.word-tile').last());
    await expect.poll(() => words.allTextContents()).not.toEqual(beforeTouch);

    const beforeKeyboard = await words.allTextContents();
    const firstHandle = handles.first();
    await firstHandle.focus();
    await firstHandle.press('Space');
    await firstHandle.press('ArrowRight');
    await firstHandle.press('Space');
    await expect.poll(() => words.allTextContents()).not.toEqual(beforeKeyboard);

    const target = ['Moscow', 'is', 'cold', 'in', 'winter.'];
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      const word = target[targetIndex] as string;
      for (;;) {
        const current = await words.allTextContents();
        const currentIndex = current.indexOf(word);
        if (currentIndex === targetIndex) break;
        const direction = currentIndex > targetIndex ? 'влево' : 'вправо';
        await page.getByRole('button', { name: `Передвинуть «${word}» ${direction}` }).click();
      }
    }
    await expect(words).toHaveText(target);

    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Верно');
    await expect(page.getByRole('button', { name: /Передвинуть/u })).toHaveCount(0);
    expect(harness.db.prepare<[], {
      answer: string; hint_used: number; hint_penalty_applied: number;
    }>(
      `SELECT answer, hint_used, hint_penalty_applied
         FROM attempts ORDER BY id DESC LIMIT 1`,
    ).get()).toEqual({
      answer: 'Moscow is cold in winter.', hint_used: 1, hint_penalty_applied: 0,
    });
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('choice отправляет текст выбранной radio-карточки', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'english' });
  try {
    const runId = await startRunDirectly(page, harness, 'english');
    await page.goto(`${harness.url}/?runId=${runId}`);

    await expect(page.getByRole('heading', { name: /Выбери правильный перевод/ })).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(3);
    await page.getByRole('radio', { name: /окно/ }).check();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Верно');

    const stored = harness.db.prepare<[], { answer: string }>(
      'SELECT answer FROM attempts ORDER BY id DESC LIMIT 1',
    ).get();
    expect(stored?.answer).toBe('окно');
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('подтверждённый спор возвращает баллы и расширяет accept[]', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'math' });
  try {
    const runId = await startRunDirectly(page, harness, 'math');

    await page.goto(`${harness.url}/?runId=${runId}`);
    await page.getByLabel('Число').fill('сорок пять');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Пока не сошлось');
    await page.getByRole('button', { name: 'Я всё-таки прав' }).click();
    await expect(page.getByText('Ты был прав — баллы вернулись.')).toBeVisible();

    const row = harness.db.prepare<[], { accept: string; is_correct: number; correct: number }>(
      `SELECT task_bank.accept, attempts.is_correct, runs.correct
         FROM attempts
         JOIN task_bank ON task_bank.id = attempts.task_id
         JOIN runs ON runs.id = attempts.run_id
        ORDER BY attempts.id DESC LIMIT 1`,
    ).get();
    expect(row).toBeDefined();
    expect(JSON.parse(row?.accept ?? '[]')).toContain('сорок пять');
    expect(row?.is_correct).toBe(1);
    expect(row?.correct).toBe(1);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('триаж проходит от старта до ранжирования тем', async ({ context, page }) => {
  const harness = await startE2eHarness({ context });
  try {
    await page.goto(harness.url);
    await page.getByRole('button', { name: 'Пройти триаж' }).click();

    for (let answered = 1; answered <= 12; answered += 1) {
      await expect(page.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /подсказ/i })).toHaveCount(0);
      await page.getByLabel('Число').fill('45');
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.getByText('Верно', { exact: true })).toBeVisible();
      await page.getByRole('button', {
        name: answered === 12 ? 'Показать итог' : 'Следующий вопрос',
      }).click();
    }

    await expect(page.getByRole('heading', { name: 'Карта тем на старте' })).toBeVisible();
    await expect(page.locator('.triage-ranking li')).toHaveCount(12);
    await expect(page.locator('.triage-ranking')).toContainText('Тема math 1');
    await expect(page.locator('.triage-ranking')).toContainText('Тема math 12');
    expect(harness.db.prepare<[], { kind: string; total: number; correct: number }>(
      'SELECT kind, total, correct FROM runs ORDER BY id DESC LIMIT 1',
    ).get()).toEqual({ kind: 'triage', total: 12, correct: 12 });
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('карточка ведёт через материал и пять ответов к зачёту и обновлённому прогнозу', async ({ context, page }) => {
  const harness = await startE2eHarness({
    context,
    triagePassed: 'math',
    controlledWorker: true,
    learningForecastFixture: 'math',
  });
  try {
    const materialId = await harness.waitForLearningMaterial('math.1');
    const initialPlan = await page.request.get(`${harness.url}/api/run/plan`, {
      headers: apiHeaders(harness),
    });
    expect(initialPlan.ok()).toBe(true);
    const initial = await initialPlan.json() as {
      forecasts: Array<{ subject: string; score: number }>;
      learning: Array<{ id: number; status: string }>;
      plan: unknown[];
      streak: { current: number; best: number; completedToday: boolean };
    };
    const forecastBefore = initial.forecasts.find(({ subject }) => subject === 'math')?.score;
    expect(forecastBefore).toBeDefined();
    expect(initial.learning).toContainEqual(expect.objectContaining({ id: materialId, status: 'ready' }));

    await page.goto(harness.url);
    await expect(page.getByRole('heading', { name: 'Разобрать слабое место' })).toBeVisible();
    await expect(page.getByText('Разбор темы: нужен зачёт')).toBeVisible();
    const card = page.locator('.learning-card').filter({
      has: page.getByText('Тема math 1', { exact: true }),
    });
    await expect(card).toContainText('Обязательный разбор');
    await expect(card).toContainText('Математика · 12 минут');
    await card.getByRole('button', { name: 'Разобрать тему' }).click();

    await expect(page.getByRole('heading', { name: 'Тема math 1', exact: true })).toBeVisible();
    await expect(page.getByText('Тестовый материал 1 по теме Тема math 1.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Возьми с собой в тест' })).toBeVisible();
    await page.getByRole('button', { name: 'Перейти к тесту' }).click();

    for (let answered = 1; answered <= 5; answered += 1) {
      await expect(page.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /подсказ/i })).toHaveCount(0);
      await page.getByLabel('Число').fill('45');
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.locator('.verdict')).toContainText('Верно');
      await page.getByRole('button', {
        name: answered === 5 ? 'Завершить тест' : 'Следующее задание',
      }).click();
    }

    await expect(page.getByRole('heading', { name: 'Зачёт' })).toBeVisible();
    await expect(page.locator('.lesson-finish-stats')).toContainText('5/5');
    await expect(page.locator('.lesson-score-note')).toContainText('Порог зачёта — 4 из 5');

    const lesson = harness.db.prepare<[], {
      kind: string;
      total: number;
      correct: number;
      status: string;
    }>(
      `SELECT runs.kind, runs.total, runs.correct, learning_materials.status
         FROM runs
         JOIN learning_runs ON learning_runs.run_id = runs.id
         JOIN learning_materials ON learning_materials.id = learning_runs.material_id
        ORDER BY runs.id DESC LIMIT 1`,
    ).get();
    expect(lesson).toEqual({ kind: 'lesson', total: 5, correct: 5, status: 'passed' });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE kind = 'run'").get())
      .toEqual({ count: 0 });

    const latestForecast = harness.db.prepare<[], { score: number }>(
      "SELECT score FROM forecast_snapshots WHERE subject = 'math' ORDER BY id DESC LIMIT 1",
    ).get();
    expect(latestForecast?.score).toBeGreaterThan(forecastBefore as number);

    await page.getByRole('link', { name: 'Вернуться к плану' }).click();
    await expect(page.getByText('Разбор темы: зачтён')).toBeVisible();
    const mathForecast = page.locator('.forecast-cards article').filter({ hasText: 'Математика' });
    await expect(mathForecast).toContainText((latestForecast?.score ?? 0).toFixed(1));
    await expect(page.locator('.learning-card').filter({
      has: page.getByText('Тема math 1', { exact: true }),
    })).toHaveCount(0);
    await expect(page.locator('.plan-cards article')).toHaveCount(initial.plan.length);
    await expect(page.getByLabel('Серия занятий')).toContainText('Первый день серии впереди');
    expect(initial.streak).toEqual({ current: 0, best: 0, completedToday: false });
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('после незачёта повтор ведёт к повторному чтению той же теории', async ({ context, page }) => {
  const harness = await startE2eHarness({
    context,
    triagePassed: 'math',
    controlledWorker: true,
    learningForecastFixture: 'math',
  });
  try {
    await harness.waitForLearningMaterial('math.1');
    await page.goto(harness.url);
    await page.locator('.learning-card').filter({
      has: page.getByText('Тема math 1', { exact: true }),
    }).getByRole('button', { name: 'Разобрать тему' }).click();
    await expect(page.getByText('Тестовый материал 1 по теме Тема math 1.')).toBeVisible();
    await page.getByRole('button', { name: 'Перейти к тесту' }).click();

    for (let answered = 1; answered <= 5; answered += 1) {
      await expect(page.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
      await page.getByLabel('Число').fill('0');
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.locator('.verdict')).toContainText('Пока не сошлось');
      await page.getByRole('button', {
        name: answered === 5 ? 'Завершить тест' : 'Следующее задание',
      }).click();
    }

    await expect(page.getByRole('heading', { name: 'Тему стоит повторить' })).toBeVisible();
    await page.getByRole('link', { name: 'Повторить разбор' }).click();
    await expect(page.getByText('Тестовый материал 1 по теме Тема math 1.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Перейти к тесту' })).toBeVisible();
    await expect(page).toHaveURL(/learningId=/u);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('готовый босс переживает reload, закрывает тему после 5 из 5 и убирает её из плана', async ({ context, page }) => {
  const harness = await startE2eHarness({ context, triagePassed: 'math', controlledWorker: true });
  try {
    await harness.prepareBoss('math.1');
    const mastery = harness.db.prepare<[string], { mastery: number }>(
      'SELECT mastery FROM topic_state WHERE topic_id = ?',
    ).get('math.1')?.mastery;
    expect(mastery).toBeGreaterThan(0.75);

    await startReadyBoss(page, harness.url);
    await expect(page.locator('.task-meta')).toContainText('задание 1 из 5');
    await answerBoss(page, '41');
    await expect(page.locator('.verdict')).toContainText('Верно');
    await page.getByRole('button', { name: 'Дальше' }).click();
    await expect(page.locator('.task-meta')).toContainText('задание 2 из 5');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Пять подряд — и тема закрыта' })).toBeVisible();
    await page.getByRole('button', { name: 'Начать бой' }).click();
    await expect(page.locator('.task-meta')).toContainText('задание 2 из 5');

    for (let position = 2; position <= 5; position += 1) {
      await answerBoss(page, String(40 + position));
      if (position < 5) {
        await expect(page.locator('.verdict')).toContainText('Верно');
        await page.getByRole('button', { name: 'Дальше' }).click();
      }
    }

    await expect(page.getByRole('heading', { name: 'Босс побеждён' })).toBeVisible();
    expect(harness.db.prepare<[], { kind: string; total: number; correct: number }>(
      'SELECT kind, total, correct FROM runs ORDER BY id DESC LIMIT 1',
    ).get()).toEqual({ kind: 'boss', total: 5, correct: 5 });
    await page.getByRole('link', { name: 'На главный экран' }).click();
    const closedTopic = page.locator('.topic-map li').filter({
      has: page.getByText('Тема math 1', { exact: true }),
    });
    await expect(closedTopic).toContainText('Закрыта');
    await expect(closedTopic).toHaveClass(/topic-closed/);
    await expect(page.locator('.plan-cards article').filter({
      has: page.getByText('Тема math 1', { exact: true }),
    })).toHaveCount(0);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('upheld-спор оставляет бой на достигнутой позиции и позволяет победить', async ({ context, page }) => {
  const harness = await startE2eHarness({
    context,
    triagePassed: 'math',
    controlledWorker: true,
    controlledDispute: true,
  });
  try {
    await harness.prepareBoss('math.1');
    await startReadyBoss(page, harness.url);
    await answerBoss(page, 'сорок один');
    await expect(page.locator('.verdict')).toContainText('Ошибка');
    await page.getByRole('button', { name: 'Я всё-таки прав' }).click();
    await expect(page.getByRole('status')).toContainText('Разбираюсь');
    await expect.poll(() => harness.db.prepare<[], { status: string }>(
      'SELECT status FROM disputes ORDER BY id DESC LIMIT 1',
    ).get()?.status).toBe('open');

    harness.upholdDispute();
    await expect(page.locator('.task-meta')).toContainText('задание 2 из 5');
    await expect(page.locator('.boss-progress')).toHaveAttribute('aria-label', 'Прогресс босса: 1 из 5');

    for (let position = 2; position <= 5; position += 1) {
      await answerBoss(page, String(40 + position));
      if (position < 5) await page.getByRole('button', { name: 'Дальше' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Босс побеждён' })).toBeVisible();
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('/parents напрямую и после reload показывает прогнозы, время, темы, ленту и флаги', async ({ context, page }) => {
  const harness = await startE2eHarness({ context });
  try {
    harness.seedParentsDashboard();
    await page.goto(`${harness.url}/parents`);
    await expect(page.getByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeVisible();
    await expect(page.locator('.parents-forecasts article')).toHaveCount(3);
    await expect(page.locator('.parents-forecasts')).toContainText('Диапазон');
    await expect(page.locator('.parents-forecasts')).toContainText('За 7 дней:');
    await expect(page.locator('.parents-time-total')).toContainText('630 мин');
    await expect(page.locator('.parents-time-total')).toContainText('6 мин');
    await expect(page.locator('.parents-bars > div')).toHaveCount(7);
    await expect(page.locator('.parents-gaps')).toContainText('Тема math 1');
    await expect(page.locator('.parents-activity')).toContainText('Обычный забег');
    await expect(page.locator('.parents-activity')).toContainText('Триаж');
    await expect(page.locator('.parents-activity')).toContainText('Босс');
    await expect(page.locator('.parents-flags')).toContainText('не растёт пять дней');
    await page.locator('.parents-activity-toggle').first().click();
    await expect(page.locator('.parents-run-detail')).toContainText('Ответ ученика');
    await expect(page.locator('.parents-run-detail')).toContainText('Правильный ответ');
    await expect(page.locator('.parents-run-detail')).toContainText('3 мин');

    await page.reload();
    await expect(page).toHaveURL(`${harness.url}/parents`);
    await expect(page.getByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeVisible();
    await expect(page.locator('.parents-time-total')).toContainText('630 мин');
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('/parents меняет эффективный доступ: разблокировать, по плану, заблокировать', async ({ context, page }) => {
  const parentPin = '123456';
  const harness = await startE2eHarness({ context, parentPin });
  try {
    await page.clock.setFixedTime(new Date('2026-08-08T12:00:00.000Z'));
    await page.goto(`${harness.url}/parents`);
    await expect(page.getByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeVisible();
    await page.getByLabel('PIN родителя').fill(parentPin);

    await page.getByRole('button', { name: 'Разблокировать' }).click();
    await page.getByRole('dialog', { name: 'Временно разблокировать компьютер?' })
      .getByRole('button', { name: 'Разблокировать' }).click();
    await expect(page.getByRole('region', { name: 'Компьютер разблокирован' }))
      .toContainText('Временный режим');
    const forcedUnlocked = await (await page.request.get(`${harness.url}/api/gate/status`, { headers: apiHeaders(harness) })).json();
    expect(forcedUnlocked).toMatchObject({
      automaticUnlocked: false,
      override: { mode: 'unlocked' },
      unlocked: true,
    });
    await assertControllerAcceptsGate(forcedUnlocked);

    await page.getByRole('button', { name: 'По плану' }).click();
    await page.getByRole('dialog', { name: 'Вернуть режим «По плану»?' })
      .getByRole('button', { name: 'Вернуть режим «По плану»' }).click();
    await expect(page.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toContainText('Режим по плану');
    const automatic = await (await page.request.get(`${harness.url}/api/gate/status`, { headers: apiHeaders(harness) })).json();
    expect(automatic).toMatchObject({
      automaticUnlocked: false,
      override: null,
      unlocked: false,
    });
    await assertControllerAcceptsGate(automatic);

    await page.getByRole('button', { name: 'Заблокировать' }).click();
    await page.getByRole('dialog', { name: 'Временно заблокировать компьютер?' })
      .getByRole('button', { name: 'Заблокировать' }).click();
    await expect(page.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toContainText('Временный режим');
    const forcedBlocked = await (await page.request.get(`${harness.url}/api/gate/status`, { headers: apiHeaders(harness) })).json();
    expect(forcedBlocked).toMatchObject({
      automaticUnlocked: false,
      override: { mode: 'blocked' },
      unlocked: false,
    });
    await assertControllerAcceptsGate(forcedBlocked);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('родитель заводит ребёнка, выпускает ссылку, ученик гасит её и начинает забег', async ({ browser, context, page }) => {
  const harness = await startE2eHarness({ context, signIn: 'parent', triagePassed: 'math' });
  try {
    await page.goto(harness.url);
    await expect(page.getByRole('heading', { name: 'Дети' })).toBeVisible();

    await page.getByLabel('Имя ребёнка').fill('Даша');
    await page.getByRole('button', { name: 'Завести ребёнка' }).click();
    const card = page.locator('.family-child').filter({ hasText: 'Даша' });
    await expect(card).toContainText('Готов к занятиям');

    const added = harness.children().find(({ name }) => name === 'Даша');
    if (added === undefined) throw new Error('E2E: заведённого ребёнка нет в управляющей базе');
    // Сервер заводит базу со схемой, но пустую: заданий и профиля в ней нет, и
    // без них первому же забегу нечего было бы выдать.
    harness.seedChild(added.id, { name: 'Даша', triagePassed: 'math' });

    await card.getByRole('button', { name: 'Выпустить ссылку' }).click();
    const invite = card.locator('.family-invite code');
    await expect(invite).toContainText('/join/');
    const joinUrl = await invite.textContent() ?? '';

    // Второй компьютер: у него нет ни родительской cookie, ни детской — только
    // ссылка. Вкладка родителя проверяла бы вход, которого ученик не проходил.
    const student = await browser.newContext();
    try {
      const studentPage = await student.newPage();
      await studentPage.goto(joinUrl);
      // Токен уходит из адресной строки сразу: он и есть весь секрет.
      await expect(studentPage).toHaveURL(`${harness.url}/`);
      // GET страницы не гасит одноразовую ссылку: это мог быть предпросмотр
      // мессенджера или антивирусный сканер. Погашение начинается только здесь.
      await studentPage.getByRole('button', { name: 'Это мой компьютер' }).click();

      const mathRun = studentPage.locator('.plan-cards article').filter({ hasText: 'Математика' });
      await mathRun.getByRole('button', { name: 'Начать' }).click();
      await expect(studentPage.getByRole('heading', { name: /вычисли значение/ })).toBeVisible();
      // Забег ушёл в базу второго ребёнка: у первого его нет. Это и есть
      // изоляция — одна база на процесс дала бы здесь единицу.
      expect(harness.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM runs WHERE kind = 'run'",
      ).get()).toEqual({ count: 0 });
    } finally {
      await student.close();
    }

    // Ссылка одноразовая: второй заход по ней ничего не открывает.
    const reused = await page.request.post(`${harness.url}${new URL(joinUrl).pathname.replace('/join/', '/api/auth/child/claim/')}`, {
      headers: { origin: harness.url },
    });
    expect(reused.status()).toBe(404);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('PIN нужен только с детской машины: неверный отвергается, вошедшему родителю не спрашивается', async ({ context, page }) => {
  const parentPin = '123456';
  const harness = await startE2eHarness({ context, parentPin });
  try {
    await page.clock.setFixedTime(new Date('2026-08-08T12:00:00.000Z'));
    await page.goto(`${harness.url}/parents`);
    await expect(page.getByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeVisible();

    // Неверный PIN — отказ на своём экране, а не выход со сводки: сессия
    // ученика цела, и режим доступа остаётся прежним.
    await page.getByLabel('PIN родителя').fill('999999');
    await page.getByRole('button', { name: 'Заблокировать' }).click();
    await page.getByRole('dialog', { name: 'Временно заблокировать компьютер?' })
      .getByRole('button', { name: 'Заблокировать' }).click();
    await expect(page.locator('.parents-access-feedback.error')).toContainText('Неверный PIN родителя');
    await expect(page.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toContainText('Режим по плану');

    await page.getByLabel('PIN родителя').fill(parentPin);
    await page.getByRole('button', { name: 'Заблокировать' }).click();
    await page.getByRole('dialog', { name: 'Временно заблокировать компьютер?' })
      .getByRole('button', { name: 'Заблокировать' }).click();
    await expect(page.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toContainText('Временный режим');

    // Та же сводка, но вошедшим родителем. Вход идёт формой, а не подставленной
    // cookie: PIN не спрашивается именно потому, что пароль уже проверен.
    await context.clearCookies();
    await page.goto(harness.url);
    await page.getByLabel('Электронная почта').fill(E2E_PARENT.email);
    await page.getByLabel('Пароль').fill(E2E_PARENT.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.locator('.family-child').filter({ hasText: 'Тимофей' })
      .getByRole('button', { name: 'Сводка' }).click();
    await expect(page.getByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeVisible();
    await expect(page.getByLabel('PIN родителя')).toHaveCount(0);
    await expect(page.locator('.parents-access-note')).toContainText('PIN не нужен');

    await page.getByRole('button', { name: 'По плану' }).click();
    await page.getByRole('dialog', { name: 'Вернуть режим «По плану»?' })
      .getByRole('button', { name: 'Вернуть режим «По плану»' }).click();
    await expect(page.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toContainText('Режим по плану');
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

test('агентский токен открывает только gate/status и ничего больше', async ({ context, page }) => {
  const harness = await startE2eHarness({ context });
  try {
    const agent = { authorization: `Bearer ${harness.agentToken()}` };

    // Контроллер доступа: заголовок вместо cookie, ровно один маршрут.
    const gate = await page.request.get(`${harness.url}/api/gate/status`, { headers: agent });
    expect(gate.status()).toBe(200);
    expect(await gate.json()).toMatchObject({ unlocked: false });

    // Агент — не детская сессия: он лежит файлом на детской машине, и допуск
    // его к обычным маршрутам означал бы, что этот файл умеет сдавать ответы.
    for (const url of ['/api/profile', '/api/run/plan', `/api/parents/${harness.childId}`]) {
      expect((await page.request.get(`${harness.url}${url}`, { headers: agent })).status()).toBe(403);
    }
    expect(
      (await page.request.post(`${harness.url}/api/run/start`, {
        headers: { ...agent, 'sec-fetch-site': 'same-origin' },
        data: {},
      })).status(),
    ).toBe(403);

    // Отозванное устройство перестаёт быть предъявителем на том же запросе.
    harness.revokeAgent();
    expect(
      (await page.request.get(`${harness.url}/api/gate/status`, { headers: agent })).status(),
    ).toBe(401);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});
