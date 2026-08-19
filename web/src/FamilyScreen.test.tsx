// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FamilyScreen } from './FamilyScreen';
import type { Family, FamilyApi, FamilyChild, FamilyDevice } from './family-api';
import './test-setup';

afterEach(cleanup);

const CHILD: FamilyChild = {
  id: 'c-1',
  parentId: 'p-1',
  name: 'Тимофей',
  status: 'ready',
  createdAt: '2026-08-01T09:00:00.000Z',
  devices: [
    {
      id: 4,
      childId: 'c-1',
      kind: 'browser',
      label: 'Ноутбук',
      inviteExpiresAt: '2026-08-03T09:00:00.000Z',
      claimedAt: '2026-08-01T10:00:00.000Z',
      createdAt: '2026-08-01T09:00:00.000Z',
    },
    {
      id: 5,
      childId: 'c-1',
      kind: 'agent',
      label: 'Контроллер',
      inviteExpiresAt: '2026-08-03T09:00:00.000Z',
      revokedAt: '2026-08-02T10:00:00.000Z',
      createdAt: '2026-08-01T09:00:00.000Z',
    },
  ],
};

const FAMILY: Family = {
  email: 'parent@example.org',
  pinConfigured: true,
  children: [CHILD],
};

function familyApi(overrides: Partial<FamilyApi> = {}, value: Family = FAMILY): FamilyApi {
  return {
    read: vi.fn().mockResolvedValue(value),
    addChild: vi.fn().mockResolvedValue({ ...CHILD, id: 'c-2', name: 'Марта', devices: [] }),
    retryProvision: vi.fn().mockResolvedValue({ ...CHILD, status: 'ready' }),
    issueDevice: vi.fn().mockResolvedValue({
      device: { ...CHILD.devices[0], id: 6, label: 'Второй компьютер', claimedAt: undefined },
      invite: { token: 'tok', expiresAt: '2026-08-05T09:00:00.000Z', path: '/join/tok' },
    }),
    revokeDevice: vi.fn().mockResolvedValue({ revoked: true, device: CHILD.devices[0] }),
    setPin: vi.fn().mockResolvedValue({ pinConfigured: true }),
    ...overrides,
  };
}

function props(api: FamilyApi) {
  return {
    api,
    email: 'parent@example.org',
    onOpenDashboard: vi.fn(),
    onLogout: vi.fn(),
  };
}

describe('состав семьи', () => {
  it('показывает детей, состояние устройств и настроенный PIN', async () => {
    render(<FamilyScreen {...props(familyApi())} />);

    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });
    expect(child).toHaveTextContent('Готов к занятиям');
    expect(child).toHaveTextContent('Подключено');
    expect(child).toHaveTextContent('Отозвано');
    expect(within(child).getByRole('button', { name: 'Отозвано' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'PIN родителя' }))
      .toHaveTextContent('PIN настроен.');
  });

  it('выпускает ссылку и показывает целый адрес ровно один раз', async () => {
    const api = familyApi();
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(within(child).getByLabelText('Подпись'), { target: { value: 'Второй компьютер' } });
    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));

    expect(await screen.findByText(`${window.location.origin}/join/tok`)).toBeInTheDocument();
    expect(api.issueDevice).toHaveBeenCalledWith('c-1', 'browser', 'Второй компьютер');
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('агенту показывает ссылку, а не токен приглашения: токен рождается при погашении', async () => {
    const api = familyApi({
      issueDevice: vi.fn().mockResolvedValue({
        device: { ...CHILD.devices[1], id: 7, claimedAt: undefined, revokedAt: undefined },
        invite: { token: 'agent-token', expiresAt: '2026-08-05T09:00:00.000Z', path: '/join/agent-token' },
      }),
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(within(child).getByLabelText('Вид устройства'), { target: { value: 'agent' } });
    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));

    // Показывается ссылка, а не токен приглашения: постоянный агентский токен
    // рождается только при её погашении, и вписанный отсюда в контроллер
    // токен приглашения дал бы вечный 401 на `gate/status`.
    expect(
      await screen.findByText(`${window.location.origin}/join/agent-token`),
    ).toBeInTheDocument();
    expect(screen.queryByText('agent-token')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Откройте ссылку — она один раз покажет токен агента/u),
    ).toBeInTheDocument();
  });

  it('не убирает первую выпущенную ссылку второй: показать её второй раз нечем', async () => {
    const invites = [
      {
        device: { ...CHILD.devices[0], id: 6, label: 'Компьютер', claimedAt: undefined },
        invite: { token: 'first', expiresAt: '2026-08-05T09:00:00.000Z', path: '/join/first' },
      },
      {
        device: { ...CHILD.devices[1], id: 7, claimedAt: undefined, revokedAt: undefined },
        invite: { token: 'second', expiresAt: '2026-08-05T09:00:00.000Z', path: '/join/second' },
      },
    ];
    const api = familyApi({
      issueDevice: vi.fn()
        .mockResolvedValueOnce(invites[0])
        .mockResolvedValueOnce(invites[1]),
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));
    expect(await screen.findByText(`${window.location.origin}/join/first`)).toBeInTheDocument();

    fireEvent.change(within(child).getByLabelText('Вид устройства'), { target: { value: 'agent' } });
    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));

    expect(await screen.findByText(`${window.location.origin}/join/second`)).toBeInTheDocument();
    // Первая ссылка осталась на экране: её токен лежит в базе отпечатком, и
    // убранный отсюда он не восстанавливается ничем.
    expect(screen.getByText(`${window.location.origin}/join/first`)).toBeInTheDocument();
  });

  it('отзывает устройство и перечитывает состав семьи', async () => {
    const api = familyApi();
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Отозвать' }));

    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith(4));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('показывает отказ сервера на заведении ребёнка', async () => {
    const api = familyApi({
      addChild: vi.fn().mockRejectedValue(new Error('База ребёнка не заведена, попробуйте позже')),
    });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Имя ребёнка'), { target: { value: 'Марта' } });
    fireEvent.click(screen.getByRole('button', { name: 'Завести ребёнка' }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('База ребёнка не заведена, попробуйте позже');
  });

  it('перечитывает семью и после сорвавшегося заведения ребёнка', async () => {
    // Строка ребёнка заводится до базы и на отказе остаётся со статусом
    // `failed`: сервер держит её нарочно, чтобы родитель видел ребёнка. Не
    // перечитав список, экран показывает обратное — ребёнка нет, — и очевидное
    // действие родителя заводит вторую строку и вторую базу.
    const failed: FamilyChild = { ...CHILD, id: 'c-2', name: 'Марта', status: 'failed', devices: [] };
    const api = familyApi({
      addChild: vi.fn().mockRejectedValue(new Error('База ребёнка не заведена, попробуйте позже')),
      read: vi.fn()
        .mockResolvedValueOnce(FAMILY)
        .mockResolvedValue({ ...FAMILY, children: [CHILD, failed] }),
    });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Имя ребёнка'), { target: { value: 'Марта' } });
    fireEvent.click(screen.getByRole('button', { name: 'Завести ребёнка' }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('База ребёнка не заведена, попробуйте позже');
    const card = await screen.findByRole('article', { name: 'Ребёнок: Марта' });
    expect(within(card).getByText('База не завелась')).toBeInTheDocument();
  });

  it('не шлёт PIN, не похожий на PIN, и показывает отказ сервера', async () => {
    const api = familyApi({
      setPin: vi.fn().mockRejectedValue(new Error('PIN недоступен: серверный pepper не настроен')),
    });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    // Границы вписаны руками: формат PIN — межмодульный инвариант, копия
    // серверного `/^\d{6,12}$/u`, а импортировать `server/` клиенту нечем.
    // Сдвинутая на клиенте граница отключает кнопку по правилу, которого на
    // сервере уже нет, — и наоборот, шлёт заведомый 400.
    const pin = screen.getByLabelText('Новый PIN');
    const save = screen.getByRole('button', { name: 'Сохранить PIN' });
    for (const bad of ['123', '12345', '1234567890123', '12345a']) {
      fireEvent.change(pin, { target: { value: bad } });
      expect(save).toBeDisabled();
    }
    for (const good of ['123456', '123456789012']) {
      fireEvent.change(pin, { target: { value: good } });
      expect(save).toBeEnabled();
    }

    fireEvent.change(pin, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить PIN' }));
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('PIN недоступен: серверный pepper не настроен');
    expect(api.setPin).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('сохраняет PIN, чистит поле и перечитывает семью', async () => {
    const api = familyApi();
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Новый PIN'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить PIN' }));

    expect(await screen.findByText('PIN сохранён.')).toBeInTheDocument();
    expect(screen.getByLabelText('Новый PIN')).toHaveValue('');
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('не отменяет сохранённый PIN отказом перечитывания', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(FAMILY)
      .mockRejectedValueOnce(new Error('Не получилось загрузить семью'));
    const api = familyApi({ read });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Новый PIN'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить PIN' }));

    // PIN сохранён — и отказ соседнего запроса не имеет права заменить это
    // сообщение ошибкой: родитель поставил бы поверх сохранённого другой.
    expect(await screen.findByText(/PIN сохранён\./u)).toBeInTheDocument();
    expect(screen.getByText(/Список семьи не обновился/u)).toBeInTheDocument();
    expect(api.setPin).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('не шлёт второй PIN по двойному щелчку', async () => {
    let release: ((value: { pinConfigured: boolean }) => void) | undefined;
    const setPin = vi.fn().mockReturnValue(new Promise<{ pinConfigured: boolean }>((done) => {
      release = done;
    }));
    const api = familyApi({ setPin });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Новый PIN'), { target: { value: '123456' } });
    const button = screen.getByRole('button', { name: 'Сохранить PIN' });
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Сохраняю…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Сохраняю…' }));
    expect(setPin).toHaveBeenCalledOnce();

    release?.({ pinConfigured: true });
    expect(await screen.findByText('PIN сохранён.')).toBeInTheDocument();
  });

  it('не считает заведение ребёнка сорвавшимся из-за отказа перечитывания', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(FAMILY)
      .mockRejectedValueOnce(new Error('Не получилось загрузить семью'));
    const api = familyApi({ read });
    render(<FamilyScreen {...props(api)} />);
    await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.change(screen.getByLabelText('Имя ребёнка'), { target: { value: 'Марта' } });
    fireEvent.click(screen.getByRole('button', { name: 'Завести ребёнка' }));

    // Ребёнок заведён: имя очищено, и повтор завёл бы второго — имена не
    // уникальны, а с ними появилась бы и вторая база.
    await waitFor(() => expect(api.addChild).toHaveBeenCalledExactlyOnceWith('Марта'));
    expect(screen.getByLabelText('Имя ребёнка')).toHaveValue('');
    // Сказано ровно то, что случилось: ребёнок заведён, не обновился список.
    // Красным «Не получилось загрузить семью» удавшееся заведение выглядит
    // отказом — и очевидное действие по нему заводит второго ребёнка.
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Ребёнок заведён. Список семьи не обновился: Не получилось загрузить семью',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('открывает сводку выбранного ребёнка вместе со списком остальных', async () => {
    const api = familyApi({}, {
      ...FAMILY,
      children: [CHILD, { ...CHILD, id: 'c-2', name: 'Марта', devices: [] }],
    });
    const screenProps = props(api);
    render(<FamilyScreen {...screenProps} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Марта' });

    fireEvent.click(within(child).getByRole('button', { name: 'Сводка' }));

    expect(screenProps.onOpenDashboard).toHaveBeenCalledWith('c-2', [
      { id: 'c-1', name: 'Тимофей' },
      { id: 'c-2', name: 'Марта' },
    ]);
  });

  it('не пускает в сводку и не даёт ссылку ребёнку без готовой базы', async () => {
    const api = familyApi({}, {
      ...FAMILY,
      children: [{ ...CHILD, status: 'provisioning', devices: [] }],
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    expect(child).toHaveTextContent('База заводится');
    expect(within(child).getByRole('button', { name: 'Сводка' })).toBeDisabled();
    expect(within(child).getByRole('button', { name: 'Выпустить ссылку' })).toBeDisabled();
  });

  it('повторяет сорвавшееся заведение той же базы, не создавая второго ребёнка', async () => {
    const failed = { ...CHILD, status: 'failed' as const, devices: [] };
    let finish: (() => void) | undefined;
    const retryProvision = vi.fn(() => new Promise<FamilyChild>((resolve) => {
      finish = () => resolve({ ...failed, status: 'ready' });
    }));
    const api = familyApi({ retryProvision }, { ...FAMILY, children: [failed] });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Повторить заведение базы' }));

    expect(await within(child).findByRole('button', { name: 'Завожу базу…' })).toBeDisabled();
    await waitFor(() => expect(api.retryProvision).toHaveBeenCalledExactlyOnceWith('c-1'));
    expect(api.addChild).not.toHaveBeenCalled();
    finish?.();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('показывает отказ повторного заведения и перечитывает состояние', async () => {
    const failed = { ...CHILD, status: 'failed' as const, devices: [] };
    const api = familyApi({
      retryProvision: vi.fn().mockRejectedValue(new Error('Диск всё ещё недоступен')),
    }, { ...FAMILY, children: [failed] });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Повторить заведение базы' }));

    expect(await within(child).findByRole('alert')).toHaveTextContent('Диск всё ещё недоступен');
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('в переключатель сводки не кладёт детей без готовой базы', async () => {
    const api = familyApi({}, {
      ...FAMILY,
      children: [
        CHILD,
        { ...CHILD, id: 'c-2', name: 'Марта', status: 'provisioning', devices: [] },
        { ...CHILD, id: 'c-3', name: 'Пётр', status: 'failed', devices: [] },
      ],
    });
    const screenProps = props(api);
    render(<FamilyScreen {...screenProps} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Сводка' }));

    // Заводящийся и сорвавшийся базы не имеют: выбор такого в переключателе
    // кончился бы отказом сводки без единого объяснения.
    expect(screenProps.onOpenDashboard).toHaveBeenCalledWith('c-1', [
      { id: 'c-1', name: 'Тимофей' },
    ]);
  });

  it('показывает отказ отзыва устройства, а не молчит о нём', async () => {
    const api = familyApi({
      revokeDevice: vi.fn().mockRejectedValue(new Error('Устройство не отозвано')),
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getAllByRole('button', { name: 'Отозвать' })[0] as HTMLElement);

    // Молча провалившийся отзыв показывает украденное устройство действующим —
    // ровно противоположное тому, что родитель только что попросил.
    expect(await screen.findByRole('alert')).toHaveTextContent('Устройство не отозвано');
    // И список перечитывается: отзыв мог состояться, а потеряться ответ, и
    // оставленное живым устройство — это второе нажатие по уже отозванному.
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('оставляет выпущенную ссылку на экране, когда отзыв не состоялся', async () => {
    const api = familyApi({
      revokeDevice: vi.fn().mockRejectedValue(new Error('Устройство не отозвано')),
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));
    expect(await within(child).findByText('/join/tok', { exact: false })).toBeInTheDocument();

    fireEvent.click(within(child).getAllByRole('button', { name: 'Отозвать' })[0] as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('Устройство не отозвано');

    // Токен показан ровно один раз и больше неоткуда взять: убрав ссылку по
    // несостоявшемуся отзыву, экран отнял бы у родителя живой адрес — причём
    // устройство при этом осталось действующим.
    expect(within(child).getByText('/join/tok', { exact: false })).toBeInTheDocument();
  });

  it('не даёт нажать «Отозвать» второй раз, пока идёт первый', async () => {
    let release: (() => void) | undefined;
    const api = familyApi({
      revokeDevice: vi.fn(() => new Promise<{ revoked: boolean; device: FamilyDevice }>(
        (resolve) => {
          release = () => resolve({ revoked: true, device: CHILD.devices[0]! });
        },
      )),
    });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    const revoke = within(child).getAllByRole('button', { name: 'Отозвать' })[0] as HTMLElement;
    fireEvent.click(revoke);

    // Пока ответа нет, кнопка не молчит и не принимает второе нажатие: иначе
    // родитель шлёт два отзыва и два перечитывания подряд, не понимая, идёт ли
    // хоть что-нибудь.
    const pending = await within(child).findByRole('button', { name: 'Отзываю…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(api.revokeDevice).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  });

  it('показывает отказ чтения семьи вместо пустого состава', async () => {
    const api = familyApi({ read: vi.fn().mockRejectedValue(new Error('Управление семьёй недоступно')) });
    render(<FamilyScreen {...props(api)} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Управление семьёй недоступно');
  });

  it('даёт повторить чтение семьи и выйти, а не запирает на сообщении', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Управление семьёй недоступно'))
      .mockResolvedValue(FAMILY);
    const api = familyApi({ read });
    const screenProps = props(api);
    render(<FamilyScreen {...screenProps} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Управление семьёй недоступно');

    // 503 неготового сервера или обрыв сети — не приговор: эффект сам не
    // повторится, а «Выйти» живёт в шапке загруженного экрана, то есть без этих
    // кнопок родитель заперт на сообщении насовсем.
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(screenProps.onLogout).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('article', { name: 'Ребёнок: Тимофей' })).toBeInTheDocument();
  });

  it('не считает выпуск ссылки и отзыв сорвавшимися из-за отказа перечитывания', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(FAMILY)
      .mockRejectedValue(new Error('Управление семьёй недоступно'));
    const api = familyApi({ read });
    render(<FamilyScreen {...props(api)} />);
    const child = await screen.findByRole('article', { name: 'Ребёнок: Тимофей' });

    fireEvent.click(within(child).getByRole('button', { name: 'Выпустить ссылку' }));

    // Одноразовый токен показан ровно один раз: назвав это отказом, экран
    // заставил бы родителя выбросить работающую ссылку и выпустить вторую.
    expect(await within(child).findByText('/join/tok', { exact: false })).toBeInTheDocument();
    expect(within(child).queryByRole('alert')).toBeNull();
    expect(await within(child).findByText(/Список семьи не обновился/u)).toBeInTheDocument();

    fireEvent.click(within(child).getAllByRole('button', { name: 'Отозвать' })[0] as HTMLElement);

    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith(4));
    expect(within(child).queryByRole('alert')).toBeNull();
  });
});
