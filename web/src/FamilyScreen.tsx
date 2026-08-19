import { useEffect, useState, type FormEvent } from 'react';
import {
  browserFamilyApi,
  type DeviceKind,
  type Family,
  type FamilyApi,
  type FamilyChild,
  type FamilyDevice,
  type IssuedInvite,
} from './family-api';

const STATUS_NAMES: Record<FamilyChild['status'], string> = {
  provisioning: 'База заводится',
  ready: 'Готов к занятиям',
  failed: 'База не завелась',
};

const KIND_NAMES: Record<DeviceKind, string> = {
  browser: 'Компьютер ученика',
  agent: 'Контроллер доступа',
};

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});

function when(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** Состояние устройства словами. Отозванное отличается от непогашенного. */
function deviceState(device: FamilyDevice): string {
  if (device.revokedAt !== undefined) return `Отозвано ${when(device.revokedAt)}`;
  if (device.claimedAt !== undefined) return `Подключено ${when(device.claimedAt)}`;
  return `Ссылка ждёт до ${when(device.inviteExpiresAt)}`;
}

/**
 * Целый адрес ссылки. Сервер отдаёт только путь: за прокси он не знает ни
 * схемы, ни внешнего имени, а родитель пришёл сюда ровно по тому адресу,
 * который нужен ребёнку.
 */
function inviteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function DeviceInvite({ issued }: { issued: IssuedInvite }) {
  return (
    <div className="family-invite" role="status">
      <p>Ссылка для «{issued.device.label === '' ? KIND_NAMES[issued.device.kind] : issued.device.label}»</p>
      {/* Токен виден ровно один раз: в базе лежит отпечаток, и повторно
          показать ссылку невозможно не по недосмотру, а по устройству
          хранения. */}
      <code>{issued.device.kind === 'agent' ? issued.invite.token : inviteUrl(issued.invite.path)}</code>
      <small>
        {issued.device.kind === 'agent'
          ? 'Токен агента впишите в настройку контроллера.'
          : 'Откройте ссылку на компьютере ученика.'} Действует до {when(issued.invite.expiresAt)}. Второй раз не покажется.
      </small>
    </div>
  );
}

function ChildCard({
  child,
  api,
  onChanged,
  onOpenDashboard,
}: {
  child: FamilyChild;
  api: FamilyApi;
  onChanged: () => Promise<void>;
  onOpenDashboard: (childId: string) => void;
}) {
  const [kind, setKind] = useState<DeviceKind>('browser');
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function issue(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      setIssued(await api.issueDevice(child.id, kind, label.trim()));
      setLabel('');
      await onChanged();
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось выпустить ссылку');
    } finally {
      setPending(false);
    }
  }

  async function revoke(deviceId: number): Promise<void> {
    setProblem(null);
    try {
      await api.revokeDevice(deviceId);
      await onChanged();
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось отозвать устройство');
    }
  }

  return (
    <article className="family-child" aria-label={`Ребёнок: ${child.name}`}>
      <header>
        <div>
          <h3>{child.name}</h3>
          <span>{STATUS_NAMES[child.status]}</span>
        </div>
        <button
          className="secondary"
          disabled={child.status !== 'ready'}
          type="button"
          onClick={() => onOpenDashboard(child.id)}
        >
          Сводка
        </button>
      </header>

      {child.devices.length === 0
        ? <p className="family-empty">Устройств пока нет. Выпустите ссылку — ученик войдёт по ней.</p>
        : <ul className="family-devices">
          {child.devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.label === '' ? KIND_NAMES[device.kind] : device.label}</strong>
                <small>{KIND_NAMES[device.kind]} · {deviceState(device)}</small>
              </div>
              <button
                disabled={device.revokedAt !== undefined}
                type="button"
                onClick={() => { void revoke(device.id); }}
              >
                {device.revokedAt === undefined ? 'Отозвать' : 'Отозвано'}
              </button>
            </li>
          ))}
        </ul>}

      <form className="family-device-form" onSubmit={(event) => { void issue(event); }}>
        <label>
          <span>Вид устройства</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as DeviceKind)}>
            <option value="browser">{KIND_NAMES.browser}</option>
            <option value="agent">{KIND_NAMES.agent}</option>
          </select>
        </label>
        <label>
          <span>Подпись</span>
          <input
            maxLength={64}
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <button disabled={pending || child.status !== 'ready'} type="submit">
          {pending ? 'Выпускаю…' : 'Выпустить ссылку'}
        </button>
      </form>

      {issued !== null && <DeviceInvite issued={issued} />}
      {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
    </article>
  );
}

export interface FamilyScreenProps {
  api?: FamilyApi;
  /** Адрес вошедшего родителя: он известен из `me` ещё до загрузки семьи. */
  email: string;
  onOpenDashboard: (childId: string, children: Array<{ id: string; name: string }>) => void;
  onLogout: () => void;
}

export function FamilyScreen({
  api = browserFamilyApi,
  email,
  onOpenDashboard,
  onLogout,
}: FamilyScreenProps) {
  const [family, setFamily] = useState<Family | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [pin, setPin] = useState('');
  const [pinFeedback, setPinFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  async function reload(): Promise<void> {
    setFamily(await api.read());
  }

  useEffect(() => {
    let active = true;
    api.read()
      .then((loaded) => { if (active) setFamily(loaded); })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить семью');
      });
    return () => { active = false; };
  }, [api]);

  async function addChild(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (adding) return;
    setAdding(true);
    setProblem(null);
    try {
      await api.addChild(name.trim());
      setName('');
      await reload();
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось завести ребёнка');
    } finally {
      setAdding(false);
    }
  }

  async function savePin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPinFeedback(null);
    try {
      await api.setPin(pin);
      setPin('');
      setPinFeedback({ kind: 'success', text: 'PIN сохранён.' });
      await reload();
    } catch (error: unknown) {
      setPinFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Не получилось сохранить PIN',
      });
    }
  }

  if (family === null) {
    // Адрес известен ещё из `me`: показывать его до загрузки семьи — способ
    // сразу подтвердить родителю, в какую учётную запись он вошёл.
    return (
      <main className="family-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <p>{email}</p>
        <p role={problem === null ? 'status' : 'alert'}>{problem ?? 'Открываю семью…'}</p>
      </main>
    );
  }

  const pinValid = /^\d{6,12}$/u.test(pin);

  return (
    <main className="family-shell">
      <header className="family-header">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div><span>Родительский вход</span><strong>{family.email}</strong></div>
        <button className="secondary" type="button" onClick={onLogout}>Выйти</button>
      </header>

      <section className="family-panel" aria-labelledby="family-children-title">
        <div className="section-heading"><p>Каждый ребёнок — своя база</p><h2 id="family-children-title">Дети</h2></div>
        {family.children.length === 0
          ? <p className="family-empty">Детей пока нет. Заведите первого — база создастся сразу.</p>
          : family.children.map((child) => (
            <ChildCard
              api={api}
              child={child}
              key={child.id}
              onChanged={reload}
              onOpenDashboard={(childId) => {
                onOpenDashboard(childId, family.children.map(({ id, name: childName }) => ({
                  id, name: childName,
                })));
              }}
            />
          ))}

        <form className="family-add" onSubmit={(event) => { void addChild(event); }}>
          <label>
            <span>Имя ребёнка</span>
            <input
              maxLength={64}
              required
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button disabled={adding} type="submit">{adding ? 'Завожу…' : 'Завести ребёнка'}</button>
        </form>
        {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
      </section>

      <section className="family-panel" aria-labelledby="family-pin-title">
        <div className="section-heading">
          <p>Подтверждение за детской машиной</p>
          <h2 id="family-pin-title">PIN родителя</h2>
        </div>
        <p>
          {family.pinConfigured
            ? 'PIN настроен. Он спрашивается только на компьютере ученика — вошедшему родителю нет.'
            : 'PIN не настроен: с детской машины режим доступа к компьютеру менять нельзя.'}
        </p>
        <form className="family-pin" onSubmit={(event) => { void savePin(event); }}>
          <label>
            <span>Новый PIN</span>
            <input
              autoComplete="off"
              inputMode="numeric"
              maxLength={12}
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          <button disabled={!pinValid} type="submit">Сохранить PIN</button>
        </form>
        <small>6–12 цифр.</small>
        {pinFeedback !== null && <p
          className={`auth-message ${pinFeedback.kind}`}
          role={pinFeedback.kind === 'error' ? 'alert' : 'status'}
        >{pinFeedback.text}</p>}
      </section>
    </main>
  );
}
