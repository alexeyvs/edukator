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
