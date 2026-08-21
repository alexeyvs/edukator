import { useEffect, useState } from 'react';
import { browserAdminApi, type AdminApi } from '../admin-api';
import { onReadOnly } from '../http';
import type { Impersonation } from '../auth-api';

/** Как называется роль захода человеку. Слова оператора, а не слова протокола. */
const ROLE_NAMES: Record<Impersonation['role'], string> = {
  browser: 'как ученик',
  parent: 'как родитель',
};

/**
 * Сколько минут захода осталось. Вверх, а не вниз: «осталось 0 минут» при живом
 * заходе — это сообщение о конце, которого ещё не было.
 */
export function minutesLeft(expiresAt: string, at: number): number {
  const left = new Date(expiresAt).getTime() - at;
  return left <= 0 ? 0 : Math.ceil(left / 60000);
}

/** Как часто пересчитывается остаток. Минуту показываем — минутой и считаем. */
const TICK_MS = 30 * 1000;

export interface ImpersonationBannerProps {
  impersonation: Impersonation;
  api?: AdminApi;
  /**
   * Куда девать оператора после выхода. По умолчанию — назад в админку: заход
   * начинался оттуда, и высадка на детском экране собственной семьи выглядела
   * бы продолжением чужой.
   */
  onLeft?: () => void;
  now?: () => number;
}

/**
 * Несъёмная полоса поверх чужого экрана.
 *
 * Без неё скриншот из имперсонации неотличим от скриншота, присланного самим
 * родителем: те же экраны, те же данные, — и разговор о том, «что оператор
 * видел», упирается в слово против слова. Поэтому полоса называет и оператора,
 * и семью, и роль, и остаток срока, а закрыть её нечем: она и есть подпись
 * кадра.
 *
 * Здесь же объясняется отказ замка на запись. Экраны семьи о заходе не знают
 * вовсе — и не должны: отказ, оставленный им, показывался бы как «не
 * получилось ответить», то есть работающий замок читался бы поломкой.
 */
export function ImpersonationBanner({
  impersonation,
  api = browserAdminApi,
  onLeft = (): void => { window.location.assign('/admin'); },
  now = (): number => Date.now(),
}: ImpersonationBannerProps) {
  const [left, setLeft] = useState(() => minutesLeft(impersonation.expiresAt, now()));
  const [refusal, setRefusal] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setLeft(minutesLeft(impersonation.expiresAt, now())), TICK_MS);
    return () => clearInterval(timer);
  }, [impersonation.expiresAt, now]);

  useEffect(() => onReadOnly(setRefusal), []);

  function leave(): void {
    if (leaving) return;
    setLeaving(true);
    setProblem(null);
    void api.stopImpersonation()
      .then(onLeft)
      .catch((error: unknown) => {
        // Cookie захода `HttpOnly`: при обрыве снять её клиент не может, и уход
        // в админку до подтверждённого ответа сервера означал бы, что заход
        // продолжается, а полоса о нём уже не рассказывает.
        setProblem(error instanceof Error ? error.message : 'Не получилось выйти из семьи');
      })
      .finally(() => setLeaving(false));
  }

  return (
    <div className="impersonation-banner" role="alert">
      <p>
        <strong>Чужая семья, только просмотр.</strong>{' '}
        Оператор {impersonation.adminEmail} смотрит {impersonation.childName}{' '}
        {ROLE_NAMES[impersonation.role]}.{' '}
        {left === 0 ? 'Срок захода вышел.' : `Осталось ${left} мин.`}
      </p>
      {refusal !== null && <p className="impersonation-refusal">{refusal}</p>}
      {problem !== null && <p className="impersonation-refusal">{problem}</p>}
      <button disabled={leaving} type="button" onClick={leave}>
        {leaving ? 'Выхожу…' : 'Выйти в админку'}
      </button>
    </div>
  );
}
