import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminChildScreen } from './AdminChildScreen';
import { AdminHomeScreen, type AdminSignOutReason } from './AdminHomeScreen';
import { AdminLoginScreen } from './AdminLoginScreen';
import { AdminLogsScreen } from './AdminLogsScreen';
import { AdminStatsScreen } from './AdminStatsScreen';
import type { AdminApi } from '../admin-api';

const CHILD_PREFIX = '/admin/child/';

/** Какой экран админки открыт. Адресом выбирается только карточка ребёнка. */
export type AdminPage =
  | { kind: 'home' }
  | { kind: 'logs' }
  | { kind: 'stats' }
  | { kind: 'child'; childId: string };

/**
 * Экран по адресу страницы.
 *
 * Адрес есть ровно у карточки ребёнка, и это не непоследовательность: сводка и
 * лента открываются от начала работы, а ссылку на карточку хочется уметь
 * отправить себе же — она и есть то, что называют в жалобе. Отсюда же
 * `/admin/child/:childId` в `APP_PAGES`: без него ссылка уходила бы в 404
 * статики.
 *
 * Битая процентная последовательность — не карточка, а главный экран:
 * `decodeURIComponent` бросает на ней `URIError`, а зовётся разбор из
 * инициализатора состояния, где вылет означает белый экран без единого слова.
 */
export function readAdminPage(pathname: string): AdminPage {
  if (!pathname.startsWith(CHILD_PREFIX)) return { kind: 'home' };
  let childId: string;
  try {
    childId = decodeURIComponent(pathname.slice(CHILD_PREFIX.length));
  } catch {
    return { kind: 'home' };
  }
  return childId === '' || childId.includes('/') ? { kind: 'home' } : { kind: 'child', childId };
}

/** Адрес открытого экрана: в истории браузера остаётся только карточка. */
function pathOf(page: AdminPage): string {
  return page.kind === 'child' ? `${CHILD_PREFIX}${encodeURIComponent(page.childId)}` : '/admin';
}

/**
 * Корень админки: вход или один из её экранов.
 *
 * Отдельного `/api/admin/me` нет намеренно — живость сессии оператора
 * показывает первый же запрос за данными. Поэтому экран сначала пробует
 * прочитать сводку и переходит ко входу по 401: лишний маршрут, который
 * отвечает ровно то же самое, был бы четвёртым местом, где живёт разбор
 * админского предъявителя.
 */
export function AdminApp({ api }: { api?: AdminApi } = {}) {
  const [signedIn, setSignedIn] = useState(true);
  const [page, setPage] = useState<AdminPage>(() => readAdminPage(window.location.pathname));
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /**
   * Вход в этой вкладке уже был. Первый заход на адрес админки тоже начинается
   * с 401 — сводка и есть проверка сессии, — и без этой отметки оператор,
   * впервые открывший админку, читал бы над формой, что его сессия закончилась.
   */
  const entered = useRef(false);

  /**
   * Переход между экранами вместе с адресом: карточка обязана быть ссылкой.
   *
   * Запись в историю только там, где адрес действительно меняется. Сводка и
   * лента живут по тому же `/admin`, и `pushState` на них клал бы в историю
   * повторы одного адреса: «назад» тогда не делает ничего видимого столько
   * раз, сколько оператор нажал кнопок, а потом уводит со страницы целиком.
   */
  const go = useCallback((next: AdminPage) => {
    setPage(next);
    const path = pathOf(next);
    if (path === window.location.pathname) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  }, []);

  /**
   * «Назад» браузера. Без слушателя адрес и экран расходятся: возврат с
   * карточки оставлял бы её нарисованной поверх `/admin`, а следующий возврат
   * уводил бы с админки, показывая её же.
   */
  useEffect(() => {
    const onPop = (): void => setPage(readAdminPage(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => { window.removeEventListener('popstate', onPop); };
  }, []);

  const signedOut = useCallback((reason: AdminSignOutReason) => {
    // Объяснение появляется только у оборвавшейся сессии: нажатая самим
    // оператором кнопка «Выйти» — не поломка, и текст про закончившуюся сессию
    // был бы сообщением о том, чего не случилось.
    setNotice(
      reason === 'expired' && entered.current ? 'Сессия закончилась. Войдите заново.' : undefined,
    );
    entered.current = false;
    setEmail(undefined);
    // Адрес возвращается вместе с экраном: форма входа, оставленная на
    // `/admin/child/<id>`, по «обновить» вернула бы карточку, которой
    // вышедшему оператору уже не покажут.
    go({ kind: 'home' });
    setSignedIn(false);
  }, [go]);

  if (!signedIn) {
    return (
      <AdminLoginScreen
        {...(api === undefined ? {} : { api })}
        {...(notice === undefined ? {} : { notice })}
        onSignedIn={(who) => {
          entered.current = true;
          setNotice(undefined);
          setEmail(who);
          setSignedIn(true);
        }}
      />
    );
  }
  if (page.kind === 'logs') {
    return (
      <AdminLogsScreen
        {...(api === undefined ? {} : { api })}
        onBack={() => go({ kind: 'home' })}
        onSignedOut={signedOut}
      />
    );
  }
  if (page.kind === 'stats') {
    return (
      <AdminStatsScreen
        {...(api === undefined ? {} : { api })}
        onBack={() => go({ kind: 'home' })}
        onChild={(childId) => go({ kind: 'child', childId })}
        onSignedOut={signedOut}
      />
    );
  }
  if (page.kind === 'child') {
    return (
      <AdminChildScreen
        {...(api === undefined ? {} : { api })}
        childId={page.childId}
        onBack={() => go({ kind: 'home' })}
        onSignedOut={signedOut}
      />
    );
  }
  return (
    <AdminHomeScreen
      {...(api === undefined ? {} : { api })}
      {...(email === undefined ? {} : { email })}
      onChild={(childId) => go({ kind: 'child', childId })}
      onLogs={() => go({ kind: 'logs' })}
      onStats={() => go({ kind: 'stats' })}
      onSignedOut={signedOut}
    />
  );
}
