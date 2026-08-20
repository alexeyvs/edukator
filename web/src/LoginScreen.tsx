import { useState, type FormEvent } from 'react';
import { browserAuthApi, type AuthApi, type Principal } from './auth-api';
import { BrandLink } from './BrandMark';

export interface LoginScreenProps {
  api?: AuthApi;
  onSignedIn: (principal: Principal) => void;
  /** Почему показан вход: «сессия кончилась» — не то же самое, что первый заход. */
  notice?: string;
}

/**
 * Вход родителя. Ребёнок сюда не приходит вовсе: у него нет ни адреса, ни
 * пароля — только ссылка от родителя, которую гасит `JoinScreen`.
 */
export function LoginScreen({ api = browserAuthApi, onSignedIn, notice }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      onSignedIn(await api.login(email.trim(), password));
    } catch (error: unknown) {
      // Пароль стирается, адрес остаётся: набирать его заново после опечатки в
      // пароле — наказание за чужую ошибку.
      setPassword('');
      setProblem(error instanceof Error ? error.message : 'Не получилось войти');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <BrandLink />
      <form className="auth-card" onSubmit={(event) => { void submit(event); }}>
        <p className="auth-kicker">Вход для родителя</p>
        <h1>Эдукатор</h1>
        {notice !== undefined && <p className="auth-notice" role="status">{notice}</p>}
        <label className="auth-field">
          <span>Электронная почта</span>
          <input
            autoComplete="username"
            name="email"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>Пароль</span>
          <input
            autoComplete="current-password"
            name="password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
        <button className="auth-submit" disabled={pending} type="submit">
          {pending ? 'Проверяю…' : 'Войти'}
        </button>
        <small>Ученик входит по ссылке от родителя, без пароля.</small>
      </form>
    </main>
  );
}
