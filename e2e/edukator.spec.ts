import { expect, test } from '@playwright/test';
import { startE2eHarness } from './harness.js';

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

test('полный забег из двенадцати заданий приводит на финальный экран', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'math' });
  try {
    await page.goto(harness.url);
    const mathRun = page.locator('.plan-cards article').filter({ hasText: 'Математика' });
    await mathRun.getByRole('button', { name: 'Начать' }).click();

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
  } finally {
    await harness.close();
  }
});

test('ошибка с исправлением не увеличивает 12 вопросов и приводит на финал', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'math' });
  try {
    const started = await page.request.post(`${harness.url}/api/run/start`, {
      data: { subject: 'math' },
    });
    expect(started.ok()).toBe(true);
    const { runId } = await started.json() as { runId: number };
    await page.goto(`${harness.url}/?runId=${runId}`);

    await expect(page.getByText('Жизни: 3 из 3')).toBeVisible();
    await page.getByLabel('Число').fill('44');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Пока не сошлось');
    await expect(page.getByText('Жизни: 2 из 3')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Я всё-таки прав' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Исправить ответ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Следующее задание' })).toBeVisible();

    await page.getByRole('button', { name: 'Исправить ответ' }).click();
    await expect(page.getByLabel('Число')).toHaveValue('');
    await page.getByLabel('Число').fill('45');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Верно');
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

test('текстовый ответ проходит обычный забег', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'russian' });
  try {
    const started = await page.request.post(`${harness.url}/api/run/start`, {
      data: { subject: 'russian' },
    });
    const { runId } = await started.json() as { runId: number };
    await page.goto(`${harness.url}/?runId=${runId}`);

    await expect(page.getByRole('heading', { name: /Вставь слово/ })).toBeVisible();
    await expect(page.getByLabel('Материал задания')).toContainText('школьный ___');
    await page.getByLabel('Ответ').fill('учебник');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.locator('.verdict')).toContainText('Верно');
  } finally {
    await harness.close();
  }
});

test('choice отправляет текст выбранной radio-карточки', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'english' });
  try {
    const started = await page.request.post(`${harness.url}/api/run/start`, {
      data: { subject: 'english' },
    });
    const { runId } = await started.json() as { runId: number };
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
  } finally {
    await harness.close();
  }
});

test('подтверждённый спор возвращает баллы и расширяет accept[]', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'math' });
  try {
    const started = await page.request.post(`${harness.url}/api/run/start`, {
      data: { subject: 'math' },
    });
    expect(started.ok()).toBe(true);
    const { runId } = await started.json() as { runId: number };

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
  } finally {
    await harness.close();
  }
});

test('триаж проходит от старта до ранжирования тем', async ({ page }) => {
  const harness = await startE2eHarness();
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
  } finally {
    await harness.close();
  }
});

test('карточка ведёт через материал и пять ответов к зачёту и обновлённому прогнозу', async ({ page }) => {
  const harness = await startE2eHarness({
    triagePassed: 'math',
    controlledWorker: true,
    learningForecastFixture: 'math',
  });
  try {
    const materialId = await harness.waitForLearningMaterial('math.1');
    const initialPlan = await page.request.get(`${harness.url}/api/run/plan`);
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

test('после незачёта повтор ведёт к повторному чтению той же теории', async ({ page }) => {
  const harness = await startE2eHarness({
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

test('готовый босс переживает reload, закрывает тему после 5 из 5 и убирает её из плана', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'math', controlledWorker: true });
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

test('upheld-спор оставляет бой на достигнутой позиции и позволяет победить', async ({ page }) => {
  const harness = await startE2eHarness({
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

test('/parents напрямую и после reload показывает прогнозы, время, темы, ленту и флаги', async ({ page }) => {
  const harness = await startE2eHarness();
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

    await page.reload();
    await expect(page).toHaveURL(`${harness.url}/parents`);
    await expect(page.getByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeVisible();
    await expect(page.locator('.parents-time-total')).toContainText('630 мин');
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});
