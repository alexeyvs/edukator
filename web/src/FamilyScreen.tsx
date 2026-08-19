import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  browserFamilyApi,
  type DeviceKind,
  type Family,
  type FamilyApi,
  type FamilyChild,
  type FamilyDevice,
  type IssuedInvite,
} from './family-api';
import { isParentPin } from './pin-format';

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

/**
 * Состояние устройства словами. Отозванное отличается от непогашенного, а
 * непогашенное — от просроченного: сервер такую ссылку уже не примет, и
 * «ссылка ждёт» над вчерашним сроком отправляло бы ребёнка в 404 вместо того,
 * чтобы позвать родителя выпустить новую.
 */
function deviceState(device: FamilyDevice, now: number): string {
  if (device.revokedAt !== undefined) return `Отозвано ${when(device.revokedAt)}`;
  if (device.claimedAt !== undefined) return `Подключено ${when(device.claimedAt)}`;
  if (Date.parse(device.inviteExpiresAt) <= now) {
    return `Ссылка просрочена ${when(device.inviteExpiresAt)}`;
  }
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
      {/* Ссылка видна ровно один раз: в базе лежит отпечаток, и повторно
          показать её невозможно не по недосмотру, а по устройству хранения.
          Агенту тоже показывается **ссылка**, а не этот токен: постоянный токен
          рождается только при погашении (`/api/auth/child/claim/:token`), и
          вписанное отсюда в настройку контроллера дало бы вечный 401. */}
      <code>{inviteUrl(issued.invite.path)}</code>
      <small>
        {issued.device.kind === 'agent'
          ? 'Откройте ссылку — она один раз покажет токен агента для настройки контроллера.'
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
  /** Перечитывание списка семьи: возвращает причину отказа, а не бросает её. */
  onChanged: () => Promise<string | undefined>;
  onOpenDashboard: (childId: string) => void;
}) {
  const [kind, setKind] = useState<DeviceKind>('browser');
  const [label, setLabel] = useState('');
  /**
   * Показанные ссылки копятся, а не сменяют друг друга: токен виден ровно один
   * раз, и вторая выпущенная ссылка убирала бы с экрана первую — вместе с
   * единственным её экземпляром. Устройство при этом продолжало бы писать
   * «Ссылка ждёт до …», то есть обещать то, чего родителю уже неоткуда взять.
   */
  const [issued, setIssued] = useState<IssuedInvite[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryingProvision, setRetryingProvision] = useState(false);
  /** Устройство, отзыв которого идёт прямо сейчас; `null` — отзыва нет. */
  const [revoking, setRevoking] = useState<number | null>(null);

  /**
   * Перечитывание отделено от самого действия и здесь, а не только у семьи
   * целиком: ссылка уже выпущена (и одноразовый токен показан ровно один раз),
   * устройство уже отозвано, и отказ обновления списка не имеет права выглядеть
   * отказом действия — иначе родитель выбрасывает работающую ссылку и выпускает
   * вторую, а по отозванному устройству жмёт «Отозвать» ещё раз.
   */
  async function refresh(): Promise<void> {
    setStale(await onChanged() ?? null);
  }

  async function issue(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setProblem(null);
    setStale(null);
    try {
      const invite = await api.issueDevice(child.id, kind, label.trim());
      setIssued((shown) => [...shown, invite]);
      setLabel('');
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось выпустить ссылку');
      setPending(false);
      return;
    }
    await refresh();
    setPending(false);
  }

  async function revoke(deviceId: number): Promise<void> {
    if (revoking !== null) return;
    setRevoking(deviceId);
    setProblem(null);
    setStale(null);
    try {
      await api.revokeDevice(deviceId);
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось отозвать устройство');
      // Список перечитывается и после отказа: отзыв мог состояться, а потеряться
      // ответ, и оставленное на экране живым устройство — это второе нажатие
      // «Отозвать» по уже отозванному.
      await refresh();
      setRevoking(null);
      return;
    }
    // Ссылка отозванного устройства убирается с экрана вместе с ним. Оставленная
    // рядом с «Отозвано», она выглядит живой — «Действует до …» написано прямо в
    // ней, — и родитель отдаёт ребёнку адрес, который сервер уже не примет. Но
    // убирается она только после **удавшегося** отзыва: одноразовый токен
    // показан ровно один раз, и снятый по сетевому сбою он унёс бы с собой
    // живую ссылку, которую больше неоткуда взять.
    setIssued((shown) => shown.filter((invite) => invite.device.id !== deviceId));
    await refresh();
    setRevoking(null);
  }

  async function retryProvision(): Promise<void> {
    if (retryingProvision) return;
    setRetryingProvision(true);
    setProblem(null);
    setStale(null);
    try {
      await api.retryProvision(child.id);
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось завести базу ребёнка');
      // Ответ мог потеряться после успешного `ready`, поэтому и на отказе
      // перечитываем состояние, не предлагая вслепую повторять ещё раз.
      await refresh();
      setRetryingProvision(false);
      return;
    }
    setStale(await onChanged() ?? null);
    setRetryingProvision(false);
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

      {child.status !== 'ready' && (
        <button
          className="secondary"
          disabled={retryingProvision}
          type="button"
          onClick={() => { void retryProvision(); }}
        >
          {retryingProvision ? 'Завожу базу…' : 'Повторить заведение базы'}
        </button>
      )}

      {child.devices.length === 0
        ? <p className="family-empty">Устройств пока нет. Выпустите ссылку — ученик войдёт по ней.</p>
        : <ul className="family-devices">
          {child.devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.label === '' ? KIND_NAMES[device.kind] : device.label}</strong>
                <small>{KIND_NAMES[device.kind]} · {deviceState(device, Date.now())}</small>
              </div>
              <button
                disabled={device.revokedAt !== undefined || revoking !== null}
                type="button"
                onClick={() => { void revoke(device.id); }}
              >
                {revoking === device.id
                  ? 'Отзываю…'
                  : device.revokedAt === undefined ? 'Отозвать' : 'Отозвано'}
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

      {issued.map((invite) => <DeviceInvite key={invite.device.id} issued={invite} />)}
      {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
      {stale !== null && (
        <p className="auth-message" role="status">Готово. Список семьи не обновился: {stale}</p>
      )}
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
  /**
   * Ребёнок заведён, а список не перечитался. Отдельно от `problem`: тем же
   * красным «Не получилось загрузить семью» удавшееся заведение выглядит
   * отказом, и очевидное действие — нажать «Завести ребёнка» ещё раз, заведя
   * второго ребёнка и вторую базу (имена не уникальны).
   */
  const [addStale, setAddStale] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [savingPin, setSavingPin] = useState(false);
  const [pinFeedback, setPinFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  // Попытка загрузки: 503 недоступной управляющей базы или обрыв сети иначе
  // оставляли бы родителя на голом сообщении навсегда — эффект сам не
  // повторится, а «Выйти» живёт в шапке загруженного экрана.
  const [attempt, setAttempt] = useState(0);

  // Номер чтения. Перечитывают список все карточки детей независимо — отзыв
  // устройства у одного и выпуск ссылки у другого идут параллельно, — и без
  // номера ответ, ушедший первым, может прийти последним: на экран встал бы
  // снимок «до» с уже отозванным устройством живым, и обновить его нечем.
  const readGeneration = useRef(0);

  async function reload(): Promise<void> {
    const generation = ++readGeneration.current;
    const loaded = await api.read();
    if (readGeneration.current === generation) setFamily(loaded);
  }

  useEffect(() => {
    let active = true;
    const generation = ++readGeneration.current;
    api.read()
      .then((loaded) => {
        if (active && readGeneration.current === generation) setFamily(loaded);
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить семью');
      });
    return () => { active = false; };
  }, [api, attempt]);

  /**
   * Перечитывание после удавшегося изменения. Отдельно от самого изменения и со
   * своим отказом: ребёнок уже заведён, PIN уже сохранён, и отказ обновления
   * списка не имеет права выглядеть отказом действия. Иначе родитель заводит
   * второго ребёнка (и вторую базу — имена не уникальны) или ставит другой PIN
   * поверх сохранённого.
   */
  async function refresh(): Promise<string | undefined> {
    try {
      await reload();
      return undefined;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : 'Не получилось обновить семью';
    }
  }

  async function addChild(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (adding) return;
    setAdding(true);
    setProblem(null);
    setAddStale(null);
    try {
      await api.addChild(name.trim());
      setName('');
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : 'Не получилось завести ребёнка');
      // Список перечитывается и после отказа: строка ребёнка заводится **до**
      // базы, и на сорвавшемся заведении сервер оставляет её со статусом
      // `failed` намеренно — чтобы родитель видел ребёнка, а не гадал, куда он
      // делся. Не перечитав, экран показывает ровно обратное: ребёнка нет, имя
      // осталось в поле, и очевидное действие — нажать «Завести» второй раз,
      // заведя вторую строку и вторую базу (имена не уникальны).
      await refresh();
      setAdding(false);
      return;
    }
    setAddStale(await refresh() ?? null);
    setAdding(false);
  }

  async function savePin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Второй отправки быть не должно: PIN ставится по живому запросу, и двойной
    // щелчок слал бы два `POST /api/family/pin` подряд.
    if (savingPin) return;
    setSavingPin(true);
    setPinFeedback(null);
    try {
      await api.setPin(pin);
      setPin('');
    } catch (error: unknown) {
      setPinFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Не получилось сохранить PIN',
      });
      setSavingPin(false);
      return;
    }
    const stale = await refresh();
    setPinFeedback({
      kind: 'success',
      text: stale === undefined ? 'PIN сохранён.' : `PIN сохранён. Список семьи не обновился: ${stale}`,
    });
    setSavingPin(false);
  }

  if (family === null) {
    // Адрес известен ещё из `me`: показывать его до загрузки семьи — способ
    // сразу подтвердить родителю, в какую учётную запись он вошёл.
    return (
      <main className="family-shell">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <p>{email}</p>
        <p role={problem === null ? 'status' : 'alert'}>{problem ?? 'Открываю семью…'}</p>
        {problem !== null && (
          <div className="family-retry">
            <button
              type="button"
              onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
            >
              Повторить
            </button>
            <button className="secondary" type="button" onClick={onLogout}>Выйти</button>
          </div>
        )}
      </main>
    );
  }

  const pinValid = isParentPin(pin);

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
              onChanged={refresh}
              onOpenDashboard={(childId) => {
                // В переключателе только готовые дети: у заводящегося и у
                // сорвавшегося базы нет, и выбор такого в списке кончился бы
                // отказом сводки без единого объяснения.
                onOpenDashboard(childId, family.children
                  .filter((sibling) => sibling.status === 'ready')
                  .map(({ id, name: childName }) => ({ id, name: childName })));
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
        {addStale !== null && (
          <p className="auth-message" role="status">
            Ребёнок заведён. Список семьи не обновился: {addStale}
          </p>
        )}
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
          <button disabled={!pinValid || savingPin} type="submit">{savingPin ? 'Сохраняю…' : 'Сохранить PIN'}</button>
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
