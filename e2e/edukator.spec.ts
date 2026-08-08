import { expect, test } from '@playwright/test';
import { startE2eHarness } from './harness.js';

test('полный забег из двенадцати заданий приводит на финальный экран', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'math' });
  try {
    await page.goto(harness.url);
    const mathRun = page.locator('.plan-cards article').filter({ hasText: 'Математика' });
    await mathRun.getByRole('button', { name: 'Начать' }).click();

    for (let answered = 1; answered <= 12; answered += 1) {
      await expect(page.getByRole('heading', { name: /чему равно 40 \+ 5/ })).toBeVisible();
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
      await expect(page.getByRole('heading', { name: /чему равно 40 \+ 5/ })).toBeVisible();
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
