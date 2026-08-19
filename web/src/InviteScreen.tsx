import { useEffect, useState, type FormEvent } from 'react';
import { browserAuthApi, type AuthApi, type Principal } from './auth-api';

/** Тот же предел, что и на сервере: короткий пароль отвергнет и он. */
export const MIN_PASSWORD_LENGTH = 10;

export interface InviteScreenProps {
  token: string;
  api?: AuthApi;
  onSignedIn: (principal: Principal) => void;
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

  useEffect(() => {
    let active = true;
    api.readInvite(token)
      .then((invite) => { if (active) setEmail(invite.email); })
      .catch((error: unknown) => {
        if (!active) return;
        setBroken(true);
        setProblem(error instanceof Error ? error.message : 'Ссылка недействительна или уже использована');
      });
    return () => { active = false; };
  }, [api, token]);

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
      onSignedIn(await api.redeemInvite(token, password));
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Ссылка недействительна или уже использована');
    } finally {
      setPending(false);
    }
  }

  if (broken) {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div className="auth-card">
          <h1>Ссылка не работает</h1>
          <p className="auth-message error" role="alert">{problem}</p>
          <p>Попросите новую ссылку — приглашение живёт 48 часов и гасится после первого пароля.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <a className="brand" href="/" aria-label="Эдукатор">Э</a>
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
