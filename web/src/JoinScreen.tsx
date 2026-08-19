import { useEffect, useRef, useState } from 'react';
import { browserAuthApi, type AuthApi, type AuthState, type DeviceClaim } from './auth-api';
import { HttpError } from './http';

export interface JoinScreenProps {
  token: string;
  api?: AuthApi;
  /** Браузерное устройство погашено: дальше решает корень приложения. */
  onClaimed: () => void;
}

/**
 * Погашение детской ссылки всегда требует явного нажатия: GET страницы могут
 * делать предпросмотр мессенджера и антивирусный сканер, а ссылка одноразовая.
 * Для уже вошедшего родителя подтверждение дополнительно называет цену.
 * Новая детская cookie по умолчанию делает активным ученика, даже если в
 * браузере жива родительская сессия. Поэтому родителю дополнительно называется
 * смена режима; вернуться он сможет явным переключателем.
 */
export function JoinScreen({ token, api = browserAuthApi, onClaimed }: JoinScreenProps) {
  const [agent, setAgent] = useState<{ childId: string; token: string } | null>(null);
  const [problem, setProblem] = useState<{ text: string; dead: boolean } | null>(null);
  // Ссылка одноразовая, а эффект в StrictMode запускается дважды: без замка
  // второй запуск сжигал бы уже погашенное приглашение и показывал бы отказ
  // поверх успеха.
  const claimed = useRef<Promise<DeviceClaim> | null>(null);
  // Счётчик повторов заводит эффект заново: обещание в замке уже отвергнуто, и
  // без нового захода его результат остался бы окончательным ответом навсегда.
  const [attempt, setAttempt] = useState(0);
  // `null` — ещё не спросили, `unknown` — спросить не вышло. Неудача вопроса
  // погашение не отменяет: ссылка одноразовая и живёт сутки, а обрыв сети на
  // проверке «кто здесь» — не повод отправить ребёнка за новой.
  const [who, setWho] = useState<AuthState | 'unknown' | null>(null);
  const [approved, setApproved] = useState(false);
  const parentPresent = who !== null && who !== 'unknown'
    && (who.kind === 'parent' || who.kind === 'both');
  const warned = parentPresent && !approved;

  useEffect(() => {
    let active = true;
    api.me()
      .then((principal) => { if (active) setWho(principal); })
      .catch(() => { if (active) setWho('unknown'); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (who === null || !approved) return undefined;
    let active = true;
    claimed.current ??= api.claimDevice(token);
    claimed.current
      .then((claim) => {
        if (!active) return;
        if (claim.kind === 'agent') setAgent({ childId: claim.childId, token: claim.token });
        else onClaimed();
      })
      .catch((error: unknown) => {
        if (!active) return;
        // 404 — единственный ответ, означающий «ссылки больше нет»: погашение
        // идёт одним `UPDATE ... WHERE` и либо состоялось, либо не тронуло
        // ничего. Обрыв сети и 503 неготового сервера приглашение не жгут, и
        // «попросите новую» на них — совет выбросить работающую ссылку.
        const dead = error instanceof HttpError && error.status === 404;
        if (!dead) claimed.current = null;
        setProblem({
          text: error instanceof Error ? error.message : 'Ссылка недействительна или уже использована',
          dead,
        });
      });
    return () => { active = false; };
  }, [api, approved, attempt, onClaimed, token, who]);

  if (warned) {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div className="auth-card">
          <h1>Это ссылка для ученика</h1>
          <p>
            В этом браузере вы вошли как родитель. Подключив здесь устройство ученика,
            вы переключите приложение в режим ученика. Родительская сессия останется,
            и вернуться к «Семье» можно будет кнопкой переключения.
          </p>
          <button type="button" onClick={() => setApproved(true)}>Всё равно подключить</button>
          <p><a href="/">Открыть ссылку на компьютере ученика</a></p>
        </div>
      </main>
    );
  }

  if (problem !== null) {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div className="auth-card">
          <h1>{problem.dead ? 'Ссылка не работает' : 'Не удалось подключить'}</h1>
          <p className="auth-message error" role="alert">{problem.text}</p>
          {problem.dead
            ? <p>Попросите родителя выпустить новую: ссылка одноразовая и живёт сутки.</p>
            : <>
              <p>Ссылку это не сожгло — попробуйте ещё раз.</p>
              <button
                type="button"
                onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
              >
                Повторить
              </button>
            </>}
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

  if (who !== null && !approved) {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div className="auth-card">
          <h1>Подключить устройство ученика</h1>
          <p>Ссылка одноразовая. Подтвердите, что открыли её на нужном компьютере.</p>
          <button type="button" onClick={() => setApproved(true)}>Это мой компьютер</button>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell" role="status">
      <a className="brand" href="/" aria-label="Эдукатор">Э</a>
      <p>{who === null ? 'Проверяю устройство…' : 'Подключаю устройство…'}</p>
    </main>
  );
}
