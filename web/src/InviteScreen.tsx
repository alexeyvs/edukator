import { useEffect, useState, type FormEvent } from 'react';
import { browserAuthApi, type AuthApi } from './auth-api';
import { HttpError } from './http';
import { BrandLink } from './BrandMark';

/** Тот же предел, что и на сервере: короткий пароль отвергнет и он. */
export const MIN_PASSWORD_LENGTH = 10;

export interface InviteScreenProps {
  token: string;
  api?: AuthApi;
  /**
   * Пароль поставлен, cookie родителя выдана. Кто предъявитель на самом деле,
   * решает не этот ответ: ссылку могли открыть в браузере ученика, а при двух
   * живых cookie `/api/auth/me` возвращает обе сессии и активную роль. Поэтому
   * наружу уходит только факт.
   */
  onSignedIn: () => void;
}

/**
 * Установка пароля родителя по одноразовой ссылке. Адрес показывается, но не
 * редактируется: он записан в самом приглашении, и поле ввода означало бы, что
 * пароль можно поставить чужой учётной записи.
 */
export function InviteScreen({ token, api = browserAuthApi, onSignedIn }: InviteScreenProps) {
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [pending, setPending] = useState(false);
  // Новый заход за чтением приглашения после сорвавшегося: сам эффект зависит
  // только от токена, и без счётчика первая неудача осталась бы окончательной.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setProblem(null);
    api.readInvite(token)
      .then((invite) => { if (active) setEmail(invite.email); })
      .catch((error: unknown) => {
        if (!active) return;
        // Чтение приглашения ничего не гасит, поэтому «ссылка мертва» здесь
        // говорит только 404. Обрыв сети и 503 неготового сервера привели бы
        // родителя к «попросите новую» — то есть заставили бы выбросить живое
        // приглашение и звать того, кто его выпускает, из командной строки.
        setBroken(error instanceof HttpError && error.status === 404);
        setProblem(error instanceof Error ? error.message : 'Ссылка недействительна или уже использована');
      });
    return () => { active = false; };
  }, [api, attempt, token]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (password !== repeat) {
      setProblem('Пароли не совпадают');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setProblem(`Пароль короче ${String(MIN_PASSWORD_LENGTH)} знаков`);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await api.redeemInvite(token, password);
      onSignedIn();
    } catch (error: unknown) {
      // 404 — «ссылки больше нет»: погашение идёт одним `UPDATE ... WHERE` и
      // либо состоялось, либо не тронуло ничего, так что повторять пароль здесь
      // уже некуда — надо просить новую. 400 (`weak-password`) и обрыв сети
      // остаются на форме: первое — свойство пароля, второе ссылку не жжёт.
      if (error instanceof HttpError && error.status === 404) setBroken(true);
      setProblem(error instanceof Error ? error.message : 'Ссылка недействительна или уже использована');
    } finally {
      setPending(false);
    }
  }

  if (broken) {
    return (
      <main className="auth-shell">
        <BrandLink />
        <div className="auth-card">
          <h1>Ссылка не работает</h1>
          <p className="auth-message error" role="alert">{problem}</p>
          <p>Попросите новую ссылку — приглашение живёт неделю и гасится после первого пароля.</p>
        </div>
      </main>
    );
  }

  // Приглашение не прочиталось, но и не погашено: форму пароля показывать не по
  // чему (адреса нет), а звать за новой ссылкой — значит выбросить живую.
  if (problem !== null && email === null) {
    return (
      <main className="auth-shell">
        <BrandLink />
        <div className="auth-card">
          <h1>Не удалось проверить ссылку</h1>
          <p className="auth-message error" role="alert">{problem}</p>
          <p>Приглашение это не погасило — попробуйте ещё раз.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>Повторить</button>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <BrandLink />
      <form className="auth-card" onSubmit={(event) => { void submit(event); }}>
        <p className="auth-kicker">Приглашение родителя</p>
        <h1>Придумайте пароль</h1>
        <p className="auth-notice" role="status">
          {email === null ? 'Проверяю ссылку…' : `Учётная запись: ${email}`}
        </p>
        <label className="auth-field">
          <span>Пароль</span>
          <input
            autoComplete="new-password"
            name="password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>Пароль ещё раз</span>
          <input
            autoComplete="new-password"
            name="repeat"
            required
            type="password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </label>
        {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
        <button className="auth-submit" disabled={pending || email === null} type="submit">
          {pending ? 'Сохраняю…' : 'Сохранить пароль и войти'}
        </button>
        <small>Не короче {MIN_PASSWORD_LENGTH} знаков. Ссылка гаснет сразу после этого шага.</small>
      </form>
    </main>
  );
}
