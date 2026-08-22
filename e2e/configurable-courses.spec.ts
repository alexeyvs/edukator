import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CHILD_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { unassignCourse } from '../server/course-assignments.js';
import {
  createDraft,
  publishRevision,
  readRevisionTopics,
  replaceDraftTopics,
} from '../server/course-catalog.js';
import { E2E_ADMIN, startE2eHarness, type E2eHarness, type E2eSide } from './harness.js';

async function useHarnessCookie(
  context: BrowserContext,
  harness: E2eHarness,
  side: E2eSide,
): Promise<void> {
  const [name, value] = harness.cookieHeader(side).split('=', 2) as [string, string];
  expect(name).toBe(side === 'parent' ? PARENT_COOKIE : CHILD_COOKIE);
  await context.clearCookies();
  await context.addCookies([{
    name, value, domain: new URL(harness.url).hostname, path: '/', httpOnly: true,
    secure: true, sameSite: side === 'parent' ? 'Strict' : 'Lax',
  }]);
}

async function answerCurrentCourse(page: Page, finishButton: string): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const answer = page.locator('#triage-answer:not([readonly])');
    const finished = page.getByRole('heading', { name: 'Карта тем на старте' });
    await expect(answer.or(finished).first()).toBeVisible();
    if (await finished.isVisible()) return;
    await answer.fill('45');
    await page.getByRole('button', { name: 'Проверить' }).click();
    const finish = page.getByRole('button', { name: finishButton });
    const next = page.getByRole('button', { name: 'Следующий вопрос' });
    await expect(finish.or(next).first()).toBeVisible();
    if (await finish.isVisible()) {
      await finish.click();
      return;
    }
    await next.click();
  }
  throw new Error(`Сценарий не дошёл до действия «${finishButton}»`);
}

test('География, 5 класс проходит OCR, назначение, новую редакцию и старый забег', async ({ context, page }) => {
  test.setTimeout(60_000);
  const harness = await startE2eHarness({ configurableCourses: true });
  try {
    await page.goto(`${harness.url}/admin`);
    await page.getByLabel('Электронная почта').fill(E2E_ADMIN.email);
    await page.getByLabel('Пароль').fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByRole('button', { name: 'Курсы' }).click();
    await page.getByLabel('Название').fill('География');
    await page.getByLabel('Класс').fill('5 класс');
    await page.getByLabel('ID (необязательно)').fill('geography-5');
    await page.getByRole('button', { name: 'Создать курс' }).click();
    await expect(page.getByRole('heading', { name: 'Источники' })).toBeVisible();

    await page.locator('input[type=file]').setInputFiles(harness.scanPath);
    await expect.poll(() => harness.control.prepare<[], { status: string }>(
      'SELECT status FROM course_sources ORDER BY id DESC LIMIT 1',
    ).get()?.status).toBe('ready');
    await page.reload();
    await expect(page.getByText('ready · 1 стр.')).toBeVisible();
    await page.getByRole('button', { name: 'Собрать по источникам' }).click();
    await expect.poll(() => harness.control.prepare<[], { status: string }>(
      "SELECT status FROM catalog_jobs WHERE type = 'build-curriculum' ORDER BY id DESC LIMIT 1",
    ).get()?.status ?? '').toMatch(/^(?:succeeded|failed)$/u);
    const buildJob = harness.control.prepare<[], { status: string; error: string | null }>(
      "SELECT status, error FROM catalog_jobs WHERE type = 'build-curriculum' ORDER BY id DESC LIMIT 1",
    ).get();
    expect(buildJob, buildJob?.error ?? 'Сборка не создала job').toMatchObject({ status: 'succeeded', error: null });
    await page.reload();
    await expect(page.locator('input[value="Географическая карта"]')).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Опубликовать редакцию' }).click();
    await expect(page.getByText('Редакция опубликована')).toBeVisible();

    await useHarnessCookie(context, harness, 'parent');
    await page.goto(harness.url);
    const courses = page.getByRole('region', { name: 'Курсы: Тимофей' });
    await courses.getByRole('checkbox', { name: /География/u }).click();
    await expect.poll(() => harness.control.prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) AS count FROM child_courses
        WHERE child_id = ? AND course_id = ? AND unassigned_at IS NULL`,
    ).get(harness.childId, 'geography-5')?.count).toBe(1);
    await page.reload();
    const assignedCourses = page.getByRole('region', { name: 'Курсы: Тимофей' });
    const geography = assignedCourses.locator('.family-course').filter({ hasText: 'География' });
    await geography.getByText(/Настроить темы/u).click();
    await geography.getByRole('checkbox', { name: 'Материки и океаны' }).click();
    await expect.poll(() => harness.control.prepare<[string], { count: number }>(
      'SELECT COUNT(*) AS count FROM child_topic_exclusions WHERE child_id = ?',
    ).get(harness.childId)?.count).toBe(1);
    await expect(geography.getByRole('checkbox', { name: 'Материки и океаны' })).not.toBeChecked();
    for (const legacyCourse of ['math', 'russian', 'english']) {
      unassignCourse(harness.control, harness.childId, legacyCourse);
    }

    await useHarnessCookie(context, harness, 'child');
    await page.goto(harness.url);
    await expect(page.getByRole('region', { name: 'География' })).toBeVisible();
    await expect(page.getByText('Материки и океаны', { exact: true })).toHaveCount(0);
    harness.seedCourseTasks('geography-5');
    await page.reload();
    await page.getByRole('button', { name: 'Пройти триаж' }).click();
    await answerCurrentCourse(page, 'Показать итог');
    await expect(page.getByRole('heading', { name: 'Карта тем на старте' })).toBeVisible();
    await page.getByRole('link', { name: 'На главный экран' }).last().click();

    const courseCard = page.locator('.plan-cards article').filter({ hasText: 'География' });
    await courseCard.first().getByRole('button', { name: 'Начать' }).click();
    const activeRun = harness.db.prepare<[], { id: number; course_revision_id: number }>(
      "SELECT id, course_revision_id FROM runs WHERE subject = 'geography-5' AND kind = 'run' AND finished_at IS NULL",
    ).get();
    expect(activeRun).toBeDefined();

    const oldRevision = activeRun?.course_revision_id as number;
    const nextDraft = createDraft(harness.control, 'geography-5', oldRevision);
    const oldTopics = readRevisionTopics(harness.control, nextDraft.id);
    const changedTopics = oldTopics.map((topic, index) => index === oldTopics.length - 1
      ? { ...topic, title: 'Климатические пояса' }
      : topic);
    const changed = replaceDraftTopics(
      harness.control,
      'geography-5',
      nextDraft.id,
      nextDraft.editVersion,
      changedTopics,
    );
    const published = publishRevision(
      harness.control, 'geography-5', nextDraft.id, changed.revision.editVersion,
    );
    expect(published.id).not.toBe(oldRevision);
    expect(harness.control.prepare<[string], { count: number }>(
      'SELECT COUNT(*) AS count FROM child_topic_exclusions WHERE child_id = ?',
    ).get(harness.childId)).toEqual({ count: 1 });

    for (let answered = 0; answered < 12; answered += 1) {
      await page.locator('#run-answer:not([readonly])').fill('45');
      await page.getByRole('button', { name: 'Проверить' }).click();
      const action = page.getByRole('button', { name: answered === 11 ? 'Завершить забег' : 'Следующее задание' });
      await action.click();
      if (answered < 11) await expect(page.locator('#run-answer:not([readonly])')).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Вот что получилось' })).toBeVisible();
    expect(harness.db.prepare<[number], { course_revision_id: number; finished_at: string | null }>(
      'SELECT course_revision_id, finished_at FROM runs WHERE id = ?',
    ).get(activeRun!.id)).toMatchObject({ course_revision_id: oldRevision, finished_at: expect.any(String) });

    await page.getByRole('link', { name: 'На главный экран' }).last().click();
    await expect(page.getByText('Климатические пояса', { exact: true })).toBeVisible();
    await expect(page.getByText('Материки и океаны', { exact: true })).toHaveCount(0);
    expect(harness.db.prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count FROM attempts a JOIN runs r ON r.id = a.run_id
        WHERE r.subject = 'geography-5'`,
    ).get()?.count).toBeGreaterThan(12);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});
