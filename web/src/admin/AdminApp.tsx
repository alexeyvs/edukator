import { useCallback, useRef, useState } from 'react';
import { AdminHomeScreen, type AdminSignOutReason } from './AdminHomeScreen';
import { AdminLoginScreen } from './AdminLoginScreen';
import { AdminLogsScreen } from './AdminLogsScreen';
import type { AdminApi } from '../admin-api';

/**
 * Корень админки: вход или главный экран.
 *
 * Отдельного `/api/admin/me` нет намеренно — живость сессии оператора
 * показывает первый же запрос за данными. Поэтому экран сначала пробует
 * прочитать сводку и переходит ко входу по 401: лишний маршрут, который
 * отвечает ровно то же самое, был бы четвёртым местом, где живёт разбор
 * админского предъявителя.
 */
export function AdminApp({ api }: { api?: AdminApi } = {}) {
  const [signedIn, setSignedIn] = useState(true);
  /**
   * Какой экран открыт. Адресом это не выбирается: `/admin` — единственная
   * страница админки в `APP_PAGES`, а вторая ссылка потребовала бы её туда
   * вписать, то есть лента аварий ломалась бы 404 статики ровно в тот день,
   * когда её открывают.
   */
  const [page, setPage] = useState<'home' | 'logs'>('home');
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /**
   * Вход в этой вкладке уже был. Первый заход на адрес админки тоже начинается
   * с 401 — сводка и есть проверка сессии, — и без этой отметки оператор,
   * впервые открывший админку, читал бы над формой, что его сессия закончилась.
   */
  const entered = useRef(false);

  const signedOut = useCallback((reason: AdminSignOutReason) => {
    // Объяснение появляется только у оборвавшейся сессии: нажатая самим
    // оператором кнопка «Выйти» — не поломка, и текст про закончившуюся сессию
    // был бы сообщением о том, чего не случилось.
    setNotice(
      reason === 'expired' && entered.current ? 'Сессия закончилась. Войдите заново.' : undefined,
    );
    entered.current = false;
    setEmail(undefined);
    setPage('home');
    setSignedIn(false);
  }, []);

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
  if (page === 'logs') {
    return (
      <AdminLogsScreen
        {...(api === undefined ? {} : { api })}
        onBack={() => setPage('home')}
        onSignedOut={signedOut}
      />
    );
  }
  return (
    <AdminHomeScreen
      {...(api === undefined ? {} : { api })}
      {...(email === undefined ? {} : { email })}
      onLogs={() => setPage('logs')}
      onSignedOut={signedOut}
    />
  );
}
