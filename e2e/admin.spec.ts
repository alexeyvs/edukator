import { expect, test } from '@playwright/test';
import { E2E_ADMIN, E2E_PARENT, startE2eHarness } from './harness.js';

/**
 * Полный путь оператора: вход в админку, список семей, заход в чужого ребёнка,
 * несъёмная полоса поверх его экранов, отказ на попытке ответить за него, выход
 * и следы всего этого в журнале действий.
 *
 * Браузер сценария приходит без единой cookie семьи: своей учётной записи у
 * оператора здесь нет, и ребёнок, которого он видит, — чужой. Ровно поэтому
 * сценарий и стоит отдельным файлом: остальные начинаются с готовой cookie
 * предъявителя, а этот проверяет, что чужие экраны открываются только заходом.
 */
test('оператор входит в админку, смотрит чужую семью и не может в ней ничего изменить', async ({ page }) => {
  const harness = await startE2eHarness({ triagePassed: 'math' });
  try {
    // Первый заход на адрес админки: сводка отвечает 401, и корень админки
    // показывает форму входа — отдельного `/api/admin/me` у неё нет.
    await page.goto(`${harness.url}/admin`);
    await expect(page.getByText('Вход оператора')).toBeVisible();

    await page.getByLabel('Электронная почта').fill(E2E_ADMIN.email);
    await page.getByLabel('Пароль').fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: 'Войти' }).click();

    // Список семей: слой 1 читает только `control.db` и потому обязан
    // нарисоваться, не открывая ни одной детской базы.
    await expect(page.getByText('Админка оператора')).toBeVisible();
    const family = page.locator('.admin-family').filter({ hasText: E2E_PARENT.email });
    const child = family.locator('.admin-children li').filter({ hasText: 'Тимофей' });
    await expect(child).toContainText('Готов к занятиям');
    await expect(child).toContainText(harness.childId);

    await child.getByRole('button', { name: 'Войти как ребёнок' }).click();

    // Полоса захода: она и есть подпись кадра. Без неё скриншот из чужой семьи
    // неотличим от присланного самим родителем.
    const banner = page.locator('.impersonation-banner');
    await expect(banner).toContainText('Чужая семья, только просмотр.');
    await expect(banner).toContainText(E2E_ADMIN.email);
    await expect(banner).toContainText('Тимофей');
    await expect(banner).toContainText('как ученик');
    // Остаток срока здесь не проверяется: сервер сценария живёт на
    // зафиксированных часах, а полоса считает минуты настоящими, и «сколько
    // осталось» на них означало бы не то, что показывают живому оператору.

    // Экраны при этом настоящие, детские: оператор пришёл смотреть ровно то,
    // что видит семья.
    const mathRun = page.locator('.plan-cards article').filter({ hasText: 'Математика' });
    await mathRun.getByRole('button', { name: 'Начать' }).click();

    // Первый замок: отказ объясняет полоса, а не детский экран. Оставленный
    // экрану, он читался бы как «не получилось начать», то есть работающий
    // замок выглядел бы поломкой.
    await expect(banner.locator('.impersonation-refusal')).toContainText('Только просмотр');
    expect(
      harness.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM runs WHERE kind = 'run'",
      ).get(),
    ).toEqual({ count: 0 });

    await banner.getByRole('button', { name: 'Выйти в админку' }).click();
    // Выход из захода возвращает в админку, а не на форму входа: cookie
    // оператора стояла рядом с cookie захода и его переживает.
    await expect(page.getByText('Админка оператора')).toBeVisible();
    await expect(page.locator('.impersonation-banner')).toHaveCount(0);

    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.getByText('Вход оператора')).toBeVisible();

    // Журнал действий, новые сверху. Экрана у него нет, а след обязан быть:
    // заход в чужую семью, не оставивший записи, — это и есть тот случай, ради
    // которого журнал заведён.
    expect(harness.adminAudit().map(({ action, childId, detail }) => ({
      action,
      childId,
      detail,
    }))).toEqual([
      { action: 'logout', childId: undefined, detail: undefined },
      {
        action: 'impersonation-end',
        childId: harness.childId,
        // Счётчик отказов записи отличает «посмотрел и вышел» от «пробовал
        // ответить за чужого ребёнка, пока не упёрся в замок».
        detail: 'browser, отказов записи: 1',
      },
      { action: 'impersonation-start', childId: harness.childId, detail: 'browser' },
      { action: 'login', childId: undefined, detail: undefined },
    ]);
    expect(harness.adminAudit().every((entry) => entry.adminId === harness.adminId)).toBe(true);

    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});

/**
 * Заход ролью родителя. Он опаснее детского: экран семьи меняет **не** базу
 * ребёнка, а `control.db`, куда `PRAGMA query_only` второго замка не достаёт
 * вовсе. Держит его поэтому один замок — выписанный руками в `requireParent`, —
 * и цена пропуска здесь выше обычной: выпущенная ссылка гасится в постоянный
 * токен устройства и переживает пятнадцатиминутный срок захода.
 */
test('заход ролью родителя не заводит детей и не выпускает ссылок', async ({ page }) => {
  const harness = await startE2eHarness();
  try {
    await page.goto(`${harness.url}/admin`);
    await page.getByLabel('Электронная почта').fill(E2E_ADMIN.email);
    await page.getByLabel('Пароль').fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByText('Админка оператора')).toBeVisible();

    const family = page.locator('.admin-family').filter({ hasText: E2E_PARENT.email });
    await family.locator('.admin-children li').filter({ hasText: 'Тимофей' })
      .getByRole('button', { name: 'Войти как родитель' }).click();

    const banner = page.locator('.impersonation-banner');
    await expect(banner).toContainText('как родитель');
    // Экран семьи настоящий: оператор пришёл смотреть ровно то, что видит
    // родитель.
    await expect(page.getByRole('heading', { name: 'Дети' })).toBeVisible();
    await expect(page.getByText(E2E_PARENT.email)).toBeVisible();
    // «Выйти» под заходом не предлагается: он читает **собственную** cookie
    // оператора и унёс бы вместе с ней несъёмную полосу — единственную кнопку
    // возврата в админку.
    await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toHaveCount(0);

    await page.getByLabel('Имя ребёнка').fill('Подложенный');
    await page.getByRole('button', { name: 'Завести ребёнка' }).click();

    await expect(banner.locator('.impersonation-refusal')).toContainText('Только просмотр');
    expect(harness.children().map(({ name }) => name)).toEqual(['Тимофей']);

    await banner.getByRole('button', { name: 'Выйти в админку' }).click();
    await expect(page.getByText('Админка оператора')).toBeVisible();

    expect(harness.adminAudit().map((entry) => entry.action)).toEqual([
      'impersonation-end',
      'impersonation-start',
      'login',
    ]);
    harness.assertCodexNotCalled();
  } finally {
    await harness.close();
  }
});
