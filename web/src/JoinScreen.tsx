import { useEffect, useRef, useState } from 'react';
import { browserAuthApi, type AuthApi, type DeviceClaim } from './auth-api';

export interface JoinScreenProps {
  token: string;
  api?: AuthApi;
  /** Браузерное устройство погашено: дальше решает корень приложения. */
  onClaimed: () => void;
}

/**
 * Погашение детской ссылки. Ничего не спрашивает: ссылка и есть весь секрет, а
 * лишний экран «нажмите, чтобы продолжить» ничего не проверял бы.
 */
export function JoinScreen({ token, api = browserAuthApi, onClaimed }: JoinScreenProps) {
  const [agent, setAgent] = useState<{ childId: string; token: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Ссылка одноразовая, а эффект в StrictMode запускается дважды: без замка
  // второй запуск сжигал бы уже погашенное приглашение и показывал бы отказ
  // поверх успеха.
  const claimed = useRef<Promise<DeviceClaim> | null>(null);

  useEffect(() => {
    let active = true;
    claimed.current ??= api.claimDevice(token);
    claimed.current
      .then((claim) => {
        if (!active) return;
        if (claim.kind === 'agent') setAgent({ childId: claim.childId, token: claim.token });
        else onClaimed();
      })
      .catch((error: unknown) => {
        if (active) {
          setProblem(error instanceof Error ? error.message : 'Ссылка недействительна или уже использована');
        }
      });
    return () => { active = false; };
  }, [api, onClaimed, token]);

  if (problem !== null) {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div className="auth-card">
          <h1>Ссылка не работает</h1>
          <p className="auth-message error" role="alert">{problem}</p>
          <p>Попросите родителя выпустить новую: ссылка одноразовая и живёт 48 часов.</p>
        </div>
      </main>
    );
  }

  if (agent !== null) {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div className="auth-card">
          <p className="auth-kicker">Устройство контроля доступа</p>
          <h1>Токен агента</h1>
          {/* Единственный раз, когда токен виден вообще: в базе лежит только
              отпечаток, и «показать ещё раз» здесь невозможно. */}
          <code className="auth-token">{agent.token}</code>
          <p>Ребёнок: {agent.childId}</p>
          <p>Впишите токен в настройку контроллера. Второй раз он не покажется — потеряли, выпускайте новую ссылку.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell" role="status">
      <a className="brand" href="/" aria-label="Эдукатор">Э</a>
      <p>Подключаю устройство…</p>
    </main>
  );
}
