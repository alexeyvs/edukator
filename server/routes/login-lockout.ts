/**
 * Запись о сработавшем запрете входа — одна на все четыре двери.
 *
 * Двери разные (пароль родителя, его PIN, подтверждение роли, пароль
 * оператора), а событие одно, и своя копия этого рассуждения у каждой из них
 * разъехалась бы молча: журнал — единственное место, где перебор виден задним
 * числом, а панель `lockouts` на главном экране показывает только **живые**
 * запреты и после паузы забывает о них навсегда.
 *
 * Пишется **переход**, а не факт отказа: `checkLoginGate` отказывает раньше
 * `recordLoginFailure`, поэтому `locked` возвращается ровно той попыткой,
 * которая предел и перешагнула. Запись на каждый отказ была бы не диагностикой,
 * а её уничтожением — подбирающий выдавил бы из хвоста журнала всё остальное
 * ровно тогда, когда остальное и понадобится.
 */
import { loginEntries, type LoginGate, type LoginTarget } from '../control-db.js';
import type { FailureLog } from '../log.js';

/** Как называется дверь человеку. Слова оператора, а не слова протокола. */
const KIND_NAMES: Record<LoginTarget['kind'], string> = {
  password: 'пароль родителя',
  pin: 'PIN родителя',
  admin: 'пароль оператора',
};

/**
 * Сломан ли счётчик прямо сейчас. Процессная защёлка, а не запись на каждый
 * отказ: `checkLoginGate` и `recordLoginFailure` работают fail-closed, то есть
 * при беде с `login_attempts` **каждая** попытка входа в любую из четырёх
 * дверей вернёт `unavailable`. Строка на попытку выдавила бы из видимого
 * хвоста журнала (`LOG_TAIL_BYTES`) всё остальное — то же рассуждение, что у
 * `login-lockout` и у `/api/health`.
 */
let counterBroken = false;

/**
 * Записывает сломанный счётчик и возвращает `true`, если этим всё сказано.
 *
 * Отдельно от `login-lockout` не только по событию, но и по месту вызова:
 * запрет живёт `LOGIN_LOCKOUT_MS`, и все попытки внутри паузы отказывает
 * `checkLoginGate` **до** счётчика. Пиши он `login-lockout` — подбирающий
 * получил бы строку на каждую попытку, то есть способ выдавить из хвоста
 * журнала всё остальное. Поломка счётчика такого рычага не даёт: она либо
 * есть, либо нет, и защёлка делает её одной записью.
 */
function noteCounterState(failures: FailureLog, target: LoginTarget, gate: LoginGate): boolean {
  if (gate.reason !== 'unavailable') {
    // Счётчик ответил — значит, работает: следующая беда с ним снова попадёт в
    // журнал, иначе первая же поломка навсегда обесценила бы эту запись.
    counterBroken = false;
    return false;
  }
  if (counterBroken) return true;
  counterBroken = true;
  failures({
    event: 'control-error',
    message: 'счётчик неудачных входов недоступен: вход закрыт на всех дверях',
    detail: `дверь: ${KIND_NAMES[target.kind]}`,
  });
  return true;
}

/**
 * То же о счётчике, но на отказе **до** сверки секрета. `login-lockout` здесь
 * не пишется никогда: сюда приходит каждая попытка внутри действующей паузы, а
 * запись полагается ровно той, что предел и перешагнула.
 */
export function noteLoginCounter(
  failures: FailureLog,
  target: LoginTarget,
  gate: LoginGate,
): void {
  noteCounterState(failures, target, gate);
}

/**
 * Пишет `login-lockout`, если эта неудача и заперла вход, и `control-error`,
 * если счётчик сломался.
 *
 * Сломанный счётчик — не перебор, и в `login-lockout` ему не место: он запирает
 * **все четыре** двери разом и держится до починки, а `/api/health` его не
 * видит вовсе — `validateControlSchema` строк `login_attempts` не читает. Без
 * этой записи «вход недоступен у всех и навсегда» не оставляло бы в журнале
 * ничего.
 */
export function noteLoginGate(
  failures: FailureLog,
  target: LoginTarget,
  counted: LoginGate,
): void {
  if (noteCounterState(failures, target, counted)) return;
  if (counted.reason !== 'locked') return;
  // Названы те же ключи, по которым счётчик и считал: панель живых запретов на
  // главном экране показывает именно их, и запись, называющая присланную
  // клиентом строку, не сходилась бы с ней ни регистром, ни длиной. Секрета в
  // записи нет ни в каком виде.
  const who = loginEntries(target).map((entry) => entry.key).join(', ');
  failures({
    event: 'login-lockout',
    message: `вход заперт перебором: ${KIND_NAMES[target.kind]}`,
    detail: `${who}, ещё ${String(Math.ceil(counted.retryAfterMs / 60000))} мин`,
  });
}
