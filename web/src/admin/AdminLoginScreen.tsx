import { useState, type FormEvent } from 'react';
import { browserAdminApi, type AdminApi } from '../admin-api';

/**
 * Тот же предел, что и `MIN_ADMIN_PASSWORD_LENGTH` на сервере. Импортировать из
 * `server/` клиент не может, поэтому копия ровно одна и с буквальным тестом:
 * поднятый на сервере минимум оставил бы здесь форму, молча отправляющую
 * короткий пароль.
 *
 * Проверять его на **входе**, а не только при установке, нужно из-за счётчика
 * перебора: попыток у оператора считанное число, и очевидная опечатка короче
 * шестнадцати знаков не имеет права сжечь одну из них и приблизить локаут.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 16;

export interface AdminLoginScreenProps {
  api?: AdminApi;
  onSignedIn: (email: string) => void;
  /** Почему показан вход: «сессия кончилась» — не то же самое, что первый заход. */
  notice?: string;
}

/**
 * Вход оператора. Отдельный экран от `LoginScreen` намеренно: публичный корень
 * не должен предлагать форму входа оператора вовсе — по ней видно, что на этой
 * машине оператор есть.
 */
export function AdminLoginScreen({
  api = browserAdminApi,
  onSignedIn,
  notice,
}: AdminLoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      setProblem(`Пароль оператора короче ${String(MIN_ADMIN_PASSWORD_LENGTH)} знаков`);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const entered = await api.login(email.trim(), password);
      onSignedIn(entered.email);
    } catch (error: unknown) {
      // Пароль стирается, адрес остаётся — та же причина, что и у входа
      // родителя: набирать адрес заново после опечатки в пароле не за что.
      setPassword('');
      setProblem(error instanceof Error ? error.message : 'Не получилось войти');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={(event) => { void submit(event); }}>
        <p className="auth-kicker">Вход оператора</p>
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
        <small>Оператора заводит только npm run admin на самой машине.</small>
      </form>
    </main>
  );
}
