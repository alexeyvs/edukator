// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import type { DayPlanResponse, HomeApi } from './home-api';
import type { FinishRunResponse } from './run-api';
import './test-setup';

afterEach(cleanup);

const PLAN: DayPlanResponse = {
  gate: {
    day: '2026-08-08', required: 3, completed: 1, remaining: 2,
    learning: { materialId: null, required: false, passed: false },
    automaticUnlocked: false, override: null, unlocked: false,
  },
  learning: [],
  plan: [
    { subject: 'math', topic: { id: 'math.fractions', title: 'Обыкновенные дроби' }, priority: 1, triagePassed: true },
    { subject: 'russian', topic: { id: 'russian.vowels', title: 'Безударные гласные' }, priority: 2, triagePassed: false },
  ],
  forecasts: [
    { subject: 'math', score: 3.5, band: .4, low: 3.1, high: 3.9 },
    { subject: 'russian', score: 4, band: .3, low: 3.7, high: 4.3 },
    { subject: 'english', score: 2.5, band: .5, low: 2, high: 3 },
  ],
  triage: [
    { subject: 'math', passed: true },
    { subject: 'russian', passed: false },
    { subject: 'english', passed: false },
  ],
  streak: { current: 3, best: 5, completedToday: false },
  topics: [
    {
      id: 'math.fractions',
      title: 'Обыкновенные дроби',
      subject: 'math',
      bossProgress: 43,
      readiness: { status: 'working', eligible: false },
    },
    {
      id: 'math.percent',
      title: 'Проценты',
      subject: 'math',
      bossProgress: 100,
      readiness: { status: 'working', eligible: true },
    },
    {
      id: 'russian.vowels',
      title: 'Безударные гласные',
      subject: 'russian',
      bossProgress: 100,
      readiness: { status: 'preparing', eligible: true, batchId: 2 },
    },
    {
      id: 'russian.syntax',
      title: 'Синтаксис',
      subject: 'russian',
      bossProgress: 100,
      readiness: { status: 'ready', eligible: true, batchId: 3 },
    },
    {
      id: 'english.articles',
      title: 'Артикли',
      subject: 'english',
      bossProgress: 100,
      readiness: { status: 'active', eligible: true, batchId: 4, runId: 11 },
    },
    {
      id: 'english.reading',
      title: 'Чтение',
      subject: 'english',
      bossProgress: 100,
      readiness: { status: 'closed', eligible: false },
    },
  ],
};

function apiWith(plan: DayPlanResponse): HomeApi {
  return {
    plan: vi.fn().mockResolvedValue(plan),
    profile: vi.fn().mockResolvedValue({ examDate: '2026-08-18' }),
    start: vi.fn().mockResolvedValue({
      runId: 7,
      resumed: false,
      progress: { total: 0, correct: 0, target: 12, done: false },
    }),
    startBoss: vi.fn().mockResolvedValue({ batchId: 3, runId: 10, resumed: false }),
    startTriage: vi.fn().mockResolvedValue({
      runId: 8,
      resumed: false,
      progress: { total: 0, correct: 0, target: 12, done: false },
    }),
    finish: vi.fn(),
  };
}

describe('главный экран', () => {
  it('показывает блокировку и точное число оставшихся обычных забегов', async () => {
    render(<HomeScreen api={apiWith(PLAN)} />);

    const card = await screen.findByRole('heading', { name: 'Компьютер заблокирован' })
      .then((heading) => heading.closest('section'));
    expect(card).toHaveTextContent('Осталось 2 обычных забега до разблокировки.');
    expect(card).toHaveTextContent('Обычные забеги: 1/3');
    expect(card).toHaveTextContent('Разбор темы: не требуется');
    expect(within(card!).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  it('раздельно показывает оба условия доступа, пока обязательный разбор не зачтён', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      gate: {
        ...PLAN.gate,
        completed: 3,
        remaining: 0,
        learning: { materialId: 22, required: true, passed: false },
      },
    })} />);

    const card = await screen.findByRole('heading', { name: 'Компьютер заблокирован' })
      .then((heading) => heading.closest('section'));
    expect(card).toHaveTextContent('Обычные забеги: 3/3');
    expect(card).toHaveTextContent('Разбор темы: нужен зачёт');
    expect(card).toHaveTextContent('Обычные забеги завершены. Для доступа нужен зачёт за разбор темы.');
  });

  it('показывает открытый доступ после выполнения дневного плана', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      gate: {
        ...PLAN.gate,
        completed: 3,
        remaining: 0,
        learning: { materialId: 22, required: true, passed: true },
        unlocked: true,
      },
    })} />);

    const card = await screen.findByRole('heading', { name: 'Компьютер разблокирован' })
      .then((heading) => heading.closest('section'));
    expect(card).toHaveTextContent('План выполнен. Доступ открыт до следующего дня.');
    expect(card).toHaveTextContent('Обычные забеги: 3/3');
    expect(card).toHaveTextContent('Разбор темы: зачтён');
    expect(within(card!).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
  });

  it('при ручной разблокировке не утверждает, что учебный план выполнен', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      gate: {
        ...PLAN.gate,
        override: {
          mode: 'unlocked',
          changedAt: '2026-08-08T12:00:00.000Z',
          expiresAt: '2026-08-08T21:00:00.000Z',
        },
        unlocked: true,
      },
    })} />);

    const card = await screen.findByRole('heading', { name: 'Компьютер разблокирован' })
      .then((heading) => heading.closest('section'));
    expect(card).toHaveTextContent('Доступ временно открыт родителем. Учебный план продолжается.');
    expect(card).not.toHaveTextContent('План выполнен');
  });

  it('при ручной блокировке показывает родительскую команду отдельно от плана', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      gate: {
        ...PLAN.gate,
        completed: 3,
        remaining: 0,
        automaticUnlocked: true,
        override: {
          mode: 'blocked',
          changedAt: '2026-08-08T12:00:00.000Z',
          expiresAt: '2026-08-08T21:00:00.000Z',
        },
        unlocked: false,
      },
    })} />);

    const card = await screen.findByRole('heading', { name: 'Компьютер заблокирован' })
      .then((heading) => heading.closest('section'));
    expect(card).toHaveTextContent('Доступ временно закрыт родителем до следующего дня.');
    expect(card).not.toHaveTextContent(/остал(ся|ось).*забег/iu);
  });

  it('показывает обязательный персональный разбор первым и явно отмечает его', async () => {
    const navigate = vi.fn();
    const view = render(<HomeScreen api={apiWith(PLAN)} navigate={navigate} />);

    await screen.findByRole('heading', { name: 'Забеги на сегодня' });
    expect(screen.queryByRole('heading', { name: 'Разобрать слабое место' })).not.toBeInTheDocument();

    view.unmount();
    render(<HomeScreen api={apiWith({
      ...PLAN,
      gate: {
        ...PLAN.gate,
        learning: { materialId: 22, required: true, passed: false },
      },
      learning: [
        {
          id: 21, subject: 'math', topic: { id: 'math.fractions', title: 'Обыкновенные дроби' },
          recommendationReason: 'Ошибки со знаменателями', estimatedMinutes: 12, status: 'ready',
        },
        {
          id: 22, subject: 'english', topic: { id: 'english.articles', title: 'Артикли' },
          recommendationReason: 'Путаются a и the', estimatedMinutes: 10, status: 'active',
        },
      ],
    })} navigate={navigate} />);

    const offer = await screen.findByRole('heading', { name: 'Разобрать слабое место' });
    const dayPlan = screen.getByRole('heading', { name: 'Забеги на сегодня' });
    expect(offer.compareDocumentPosition(dayPlan) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const cards = screen.getAllByRole('article').filter((card) => card.classList.contains('learning-card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Артикли');
    expect(cards[0]).toHaveTextContent('Обязательный разбор');
    expect(cards[1]).toHaveTextContent('Обыкновенные дроби');
    expect(cards[1]).not.toHaveTextContent('Обязательный разбор');
    expect(screen.getByText('Ошибки со знаменателями')).toBeInTheDocument();
    expect(screen.getByText('Математика · 12 минут')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать тему' }));
    expect(navigate).toHaveBeenCalledWith('/?learningId=21');
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить разбор' }));
    expect(navigate).toHaveBeenCalledWith('/?learningId=22');
  });

  it.each([
    [{ current: 0, best: 0, completedToday: false }, 'Первый день серии впереди', 'Один обычный забег положит начало.'],
    [{ current: 3, best: 5, completedToday: false }, '3 дн. подряд', 'Сегодняшний забег продолжит серию.'],
    [{ current: 4, best: 5, completedToday: true }, '4 дн. подряд', 'Сегодня серия уже продолжена.'],
    [{ current: 0, best: 5, completedToday: false }, 'Начни новую серию', 'Лучший результат — 5 дн.'],
  ] as const)('показывает состояние серии %# без обвиняющего текста', async (streak, title, note) => {
    render(<HomeScreen api={apiWith({ ...PLAN, streak })} />);

    const card = await screen.findByLabelText('Серия занятий');
    expect(card).toHaveTextContent(title);
    expect(card).toHaveTextContent(note);
    expect(card).not.toHaveTextContent(/пропустил|потерял|оборвал/iu);
  });

  it('до первого триажа показывает только его, после — план дня', async () => {
    const before = apiWith({
      ...PLAN,
      triage: PLAN.triage.map((item) => ({ ...item, passed: false })),
    });
    const view = render(<HomeScreen api={before} now={() => new Date('2026-08-08T12:00:00Z')} />);

    expect(await screen.findByRole('button', { name: 'Пройти триаж' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Начать' })).not.toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();

    view.unmount();
    render(<HomeScreen api={apiWith(PLAN)} />);

    expect(await screen.findByRole('heading', { name: 'Забеги на сегодня' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Начать' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Пройти триаж · Русский язык' })).toBeInTheDocument();
    expect(screen.getByText('3.5')).toBeInTheDocument();
    expect(screen.getByText('4.0')).toBeInTheDocument();
  });

  it('пустой план дня даёт явное завершённое состояние', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      gate: { ...PLAN.gate, completed: 3, remaining: 0, unlocked: true },
      plan: [],
    })} />);

    expect(await screen.findByText('На сегодня всё закрыто')).toBeInTheDocument();
    expect(screen.getByText('3 из 3 завершено')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Начать' })).not.toBeInTheDocument();
  });

  it('показывает и продолжает активный слот дневного плана', async () => {
    const navigate = vi.fn();
    const api = apiWith({
      ...PLAN,
      plan: [{
        ...PLAN.plan[0]!,
        active: {
          runId: 17,
          startedAt: '2026-08-07T12:00:00.000Z',
          progress: {
            total: 7,
            correct: 4,
            target: 12,
            done: false,
            lives: { total: 3, remaining: 1, retryAvailable: false },
          },
        },
      }, PLAN.plan[1]!],
    });
    render(<HomeScreen
      api={api}
      navigate={navigate}
      now={() => new Date('2026-08-08T12:00:00.000Z')}
    />);

    fireEvent.click(await screen.findByRole('button', { name: 'Продолжить' }));
    expect(screen.getByText('Математика · 7 из 12 · начат вчера')).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith('/?runId=17');
    expect(api.start).not.toHaveBeenCalled();
  });

  it('завершает с главной активный забег, который уже достиг цели', async () => {
    const summary: FinishRunResponse = {
      runId: 18,
      total: 12,
      correct: 9,
      xp: 180,
      touchedTopics: [],
      closedTopics: [],
      declinedTopics: [],
      forecast: { id: 1, subject: 'math', score: 4, band: .3, createdAt: '2026-08-08T12:00:00Z' },
    };
    const api = apiWith({
      ...PLAN,
      plan: [{
        ...PLAN.plan[0]!,
        active: {
          runId: 18,
          startedAt: '2026-08-06T12:00:00.000Z',
          progress: {
            total: 12,
            correct: 9,
            target: 12,
            done: true,
            lives: { total: 3, remaining: 0, retryAvailable: false },
          },
        },
      }],
    });
    vi.mocked(api.finish).mockResolvedValue(summary);
    const navigate = vi.fn();
    render(<HomeScreen
      api={api}
      navigate={navigate}
      now={() => new Date('2026-08-08T12:00:00.000Z')}
    />);

    expect(await screen.findByText('Математика · 12 из 12 · начат 6 августа')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Завершить' }));

    expect(await screen.findByText('Забег завершён')).toBeInTheDocument();
    expect(api.finish).toHaveBeenCalledWith(18);
    expect(api.start).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('не показывает двойку, пока данных по предмету слишком мало', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      forecasts: PLAN.forecasts.map((forecast) => forecast.subject === 'math'
        ? { ...forecast, score: 2, band: .9, low: 2, high: 2.9 }
        : forecast),
    })} />);

    const card = await screen.findByText('Собираем данные').then((value) => value.closest('article'));
    expect(card).toHaveTextContent('Собираем данные');
    expect(card).toHaveTextContent('Оценка появится после ещё нескольких тем');
    expect(card).not.toHaveTextContent('2.0');
    expect(card).not.toHaveTextContent('диапазон 2.0–2.9');
  });

  it('ведёт на финал, если подхваченный забег уже достиг цели', async () => {
    const api = apiWith(PLAN);
    vi.mocked(api.start).mockResolvedValue({
      runId: 7,
      resumed: true,
      progress: { total: 12, correct: 9, target: 12, done: true },
    });
    const summary: FinishRunResponse = {
      runId: 7,
      total: 12,
      correct: 9,
      xp: 180,
      touchedTopics: [],
      closedTopics: [],
      declinedTopics: [],
      forecast: { id: 1, subject: 'math', score: 4, band: .3, createdAt: '2026-08-08T12:00:00Z' },
    };
    vi.mocked(api.finish).mockResolvedValue(summary);
    const navigate = vi.fn();
    render(<HomeScreen api={api} navigate={navigate} />);

    fireEvent.click(await screen.findAllByRole('button', { name: 'Начать' }).then((items) => items[0]!));

    expect(await screen.findByText('Забег завершён')).toBeInTheDocument();
    expect(api.finish).toHaveBeenCalledWith(7);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('запускает ровно тему выбранной карточки плана', async () => {
    const api = apiWith(PLAN);
    render(<HomeScreen api={api} navigate={vi.fn()} />);

    fireEvent.click(await screen.findAllByRole('button', { name: 'Начать' }).then((items) => items[1]!));

    await waitFor(() => expect(api.start).toHaveBeenCalledWith('russian', 'russian.vowels'));
  });

  it('считает дату экзамена от московской полуночи', async () => {
    render(<HomeScreen api={apiWith(PLAN)} now={() => new Date('2026-08-07T21:30:00.000Z')} />);

    const countdown = await screen.findByLabelText('Обратный отсчёт до экзамена');
    expect(countdown).toHaveTextContent('10');
    expect(countdown).not.toHaveTextContent('11');
  });

  it('показывает рейтинг на финале подхваченного триажа', async () => {
    const api = apiWith({
      ...PLAN,
      triage: PLAN.triage.map((item) => ({ ...item, passed: false })),
    });
    vi.mocked(api.startTriage).mockResolvedValue({
      runId: 8,
      resumed: true,
      progress: { total: 12, correct: 7, target: 12, done: true },
    });
    vi.mocked(api.finish).mockResolvedValue({
      runId: 8,
      total: 12,
      correct: 7,
      xp: 0,
      touchedTopics: [{
        topicId: 'russian.vowels',
        title: 'Безударные гласные',
        before: 0,
        after: 0.35,
      }],
      closedTopics: [],
      declinedTopics: [],
      forecast: { id: 2, subject: 'russian', score: 3, band: .4, createdAt: '2026-08-08T12:00:00Z' },
    });
    render(<HomeScreen api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Пройти триаж' }));

    expect(await screen.findByText('Триаж завершён')).toBeInTheDocument();
    expect(screen.getByText('Безударные гласные')).toBeInTheDocument();
    expect(screen.queryByText('Забег завершён')).not.toBeInTheDocument();
  });

  it('показывает ошибку старта и оставляет экран доступным', async () => {
    const api = apiWith(PLAN);
    vi.mocked(api.start).mockRejectedValue(new Error('Забег временно недоступен'));
    render(<HomeScreen api={api} />);

    fireEvent.click(await screen.findAllByRole('button', { name: 'Начать' }).then((items) => items[0]!));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Забег временно недоступен'));
    expect(screen.getAllByRole('button', { name: 'Начать' })[0]).toBeEnabled();
  });

  it('показывает ошибку начальной загрузки без вечного индикатора', async () => {
    const api = apiWith(PLAN);
    vi.mocked(api.plan).mockRejectedValue(new Error('План временно недоступен'));
    render(<HomeScreen api={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('План временно недоступен');
    expect(screen.queryByLabelText('Загрузка плана')).not.toBeInTheDocument();
  });

  it('показывает прогресс до босса и остальные состояния карты без сырого mastery', async () => {
    const plan = {
      ...PLAN,
      topics: PLAN.topics.map((topic) => ({ ...topic, mastery: 0.82 })),
    };
    const { container } = render(<HomeScreen api={apiWith(plan)} />);

    expect(await screen.findByRole('heading', { name: 'Карта тем' })).toBeInTheDocument();
    for (const subject of ['Математика', 'Русский язык', 'Английский язык']) {
      expect(screen.getAllByRole('heading', { name: subject }).length).toBeGreaterThan(0);
    }
    const progress = screen.getByRole('progressbar', {
      name: 'Прогресс темы «Обыкновенные дроби» до босса',
    });
    expect(progress).toHaveAttribute('aria-valuenow', '43');
    expect(screen.getByText('43%')).toBeInTheDocument();
    expect(screen.queryByText('В работе')).not.toBeInTheDocument();
    expect(screen.getAllByText('Босс готовится')).toHaveLength(2);
    expect(screen.getByText('Можно вызвать босса')).toBeInTheDocument();
    expect(screen.getByText('Бой уже начат')).toBeInTheDocument();
    expect(screen.getByText('Закрыта')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('0.82');
    expect(screen.queryByRole('link', { name: /родител/iu })).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/parents"]')).toBeNull();
  });

  it('готовую тему запускает как boss и открывает экран боя', async () => {
    const api = apiWith(PLAN);
    const navigate = vi.fn();
    render(<HomeScreen api={api} navigate={navigate} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Вызвать босса' }));

    await waitFor(() => expect(api.startBoss).toHaveBeenCalledWith('russian.syntax'));
    expect(navigate).toHaveBeenCalledWith('/?runId=10&kind=boss');
  });

  it('не предлагает старт готового батча, если тема больше не eligible', async () => {
    const api = apiWith({
      ...PLAN,
      topics: PLAN.topics.map((topic) => topic.id === 'russian.syntax'
        ? { ...topic, bossProgress: 99, readiness: { ...topic.readiness, eligible: false } }
        : topic),
    });
    render(<HomeScreen api={api} />);

    const title = await screen.findByText('Синтаксис');
    const item = title.closest('li');
    expect(item).not.toBeNull();
    expect(within(item!).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
    expect(within(item!).queryByText('В работе')).not.toBeInTheDocument();
    expect(within(item!).queryByRole('button')).not.toBeInTheDocument();
    expect(api.startBoss).not.toHaveBeenCalled();
  });

  it('показывает спокойную подготовку без кнопки и не блокирует обычный план', async () => {
    render(<HomeScreen api={apiWith(PLAN)} />);

    const map = await screen.findByRole('heading', { name: 'Карта тем' }).then((value) => value.closest('section'));
    const topic = within(map!).getAllByText('Безударные гласные')
      .find((value) => value.closest('li') !== null)?.closest('li') ?? null;
    expect(topic).not.toBeNull();
    expect(within(topic!).getByText('Босс готовится')).toBeInTheDocument();
    expect(within(topic!).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Начать' })[0]).toBeEnabled();
  });

  it('показывает ошибку API старта босса и возвращает кнопку', async () => {
    const api = apiWith(PLAN);
    vi.mocked(api.startBoss).mockRejectedValue(new Error('Босс пока недоступен'));
    render(<HomeScreen api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Вызвать босса' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Босс пока недоступен');
    expect(screen.getByRole('button', { name: 'Вызвать босса' })).toBeEnabled();
  });

  it('не предлагает закрытую тему в карточках плана дня', async () => {
    render(<HomeScreen api={apiWith({
      ...PLAN,
      plan: [...PLAN.plan, {
        subject: 'english',
        topic: { id: 'english.reading', title: 'Чтение' },
        priority: 3,
        triagePassed: true,
      }],
    })} />);

    await screen.findByRole('heading', { name: 'Забеги на сегодня' });
    const dayPlan = screen.getByRole('heading', { name: 'Забеги на сегодня' }).closest('section');
    expect(dayPlan).not.toBeNull();
    expect(within(dayPlan!).queryByText('Чтение')).not.toBeInTheDocument();
    expect(within(dayPlan!).getAllByRole('button', { name: 'Начать' })).toHaveLength(2);
  });
});
