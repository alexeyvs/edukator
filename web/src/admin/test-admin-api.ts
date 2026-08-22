import { vi } from 'vitest';
import type { AdminApi } from '../admin-api';

/**
 * Заглушка админского API — одна на все семь экранных тестов админки.
 *
 * По умолчанию **всё** отказывает: тест, которому метод не нужен, не должен
 * получать на него тихий успех — иначе лишний запрос экрана остаётся
 * незамеченным, а именно он и означает, что экран открывает базы, которых
 * открывать не должен. Что нужно этому тесту, он называет сам.
 *
 * Общая, а не своя в каждом файле, по той же причине, что и `testAuthApi`:
 * новый метод контракта иначе ломает семь установок сразу и правится семью
 * одинаковыми строками — то есть до первого раза, когда допишут шесть из семи.
 */
export function testAdminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  const unused = (what: string) => vi.fn().mockRejectedValue(new Error(`${what} в этом тесте не спрашивается`));
  return {
    login: unused('вход оператора'),
    logout: unused('выход оператора'),
    overview: unused('сводка'),
    logs: unused('журнал аварий'),
    stats: unused('статистика'),
    child: unused('карточка ребёнка'),
    impersonate: unused('заход в семью'),
    stopImpersonation: unused('выход из захода'),
    createFamily: unused('заведение семьи'),
    issueParentInvite: unused('ссылка на смену пароля'),
    setParentPassword: unused('пароль семьи'),
    courses: unused('каталог курсов'),
    createCourse: unused('создание курса'),
    course: unused('карточка курса'),
    updateCourse: unused('метаданные курса'),
    courseDraft: unused('черновик курса'),
    createCourseDraft: unused('новый черновик курса'),
    replaceCourseTopics: unused('темы курса'),
    publishCourse: unused('публикация курса'),
    archiveCourse: unused('архивирование курса'),
    courseSources: unused('источники курса'),
    uploadCourseSource: unused('загрузка источника'),
    deleteCourseSource: unused('удаление источника'),
    courseSourceStatus: unused('состояние OCR'),
    retryCourseSource: unused('повтор OCR'),
    courseBuild: unused('состояние сборки курса'),
    buildCourseDraft: unused('сборка курса'),
    ...overrides,
  };
}
