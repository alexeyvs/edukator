import { useEffect, useState } from 'react';
import {
  browserAdminApi,
  type AdminApi,
  type AdminChildDetail,
  type AdminGateState,
  type AdminTopicCard,
} from '../admin-api';
import { HttpError } from '../http';
import type { AdminSignOutReason } from './AdminHomeScreen';

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

export function cardTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/**
 * Почему тема не выдаётся. Годных заданий может не быть по трём разным причинам,
 * и на экране они обязаны различаться: банк пуст, всё занято боссом или разбором,
 * тема закрыта победой. Свести их к «нет заданий» значило бы отправить оператора
 * чинить прогрев там, где чинить нечего.
 */
export function topicNote(topic: AdminTopicCard): string {
  if (topic.closedAt !== undefined) return 'Тема закрыта';
  if (topic.bank.valid > 0) return '';
  if (topic.bank.reserved > 0) return 'Всё занято боссом или разбором';
  if (topic.bank.pending > 0) return 'Ждёт проверки';
  return 'Банк пуст';
}

function Gate({ gate }: { gate: AdminGateState }) {
  return (
    <section className="admin-panel">
      <h2>Дневной доступ</h2>
      <dl className="admin-numbers">
        <div>
          <dt>Забеги за {gate.day}</dt>
          <dd>{gate.completed} из {gate.required}</dd>
          <small>осталось {gate.remaining}</small>
        </div>
        <div>
          <dt>Компьютер</dt>
          <dd>{gate.unlocked ? 'Открыт' : 'Закрыт'}</dd>
          {/* Ручная команда родителя названа отдельно: с ней итог перестаёт
              следовать из числа забегов, и молчание об этом читалось бы как
              поломка расчёта. */}
          <small>
            {gate.override === null
              ? `автоматически ${gate.automaticUnlocked ? 'открыт' : 'закрыт'}`
              : `команда родителя: ${gate.override.mode === 'unlocked' ? 'открыт' : 'закрыт'}`}
          </small>
        </div>
        <div>
          <dt>Разбор</dt>
          <dd>{gate.learning.materialId ?? '—'}</dd>
          <small>
            {gate.learning.required ? 'обязателен' : 'не обязателен'},
            {' '}{gate.learning.passed ? 'зачтён' : 'не зачтён'}
          </small>
        </div>
      </dl>
    </section>
  );
}

export interface AdminChildScreenProps {
  api?: AdminApi;
  childId: string;
  /** Вернуться к сводке: карточка — экран админки, а не отдельное приложение. */
  onBack?: () => void;
  /** Сессии оператора больше нет: решение показать вход принимает корень. */
  onSignedOut: (reason: AdminSignOutReason) => void;
}

/**
 * Экран слоя 3: карточка одного ребёнка.
 *
 * Кеша у неё нет ни на сервере, ни здесь, и отметки «данные на 12:41» тоже: по
 * жалобе смотрят состояние сейчас, а сохранённый снимок отвечал бы на вопрос
 * «что было до того, как я попросил перезапустить».
 *
 * Содержания на экране нет вовсе — ни одной формулировки, ни одного ответа:
 * прочитать написанное ребёнком можно только имперсонацией, и она попадает в
 * аудит с именем оператора.
 */
export function AdminChildScreen({
  api = browserAdminApi,
  childId,
  onBack,
  onSignedOut,
}: AdminChildScreenProps) {
  const [card, setCard] = useState<AdminChildDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Новая попытка после сорвавшейся: эффект сам не повторится (карточка так и
  // остаётся `null`), и без счётчика обрыв сети запирал бы оператора.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api.child(childId)
      .then((loaded) => {
        if (!active) return;
        setCard(loaded);
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // 401 — кончившаяся сессия оператора, а не поломка карточки.
        if (error instanceof HttpError && error.status === 401) {
          onSignedOut('expired');
          return;
        }
        setProblem(error instanceof Error
          ? error.message
          : 'Не получилось загрузить карточку ребёнка');
      });
    return () => { active = false; };
  }, [api, childId, attempt, onSignedOut]);

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span>Админка оператора</span>
          <strong>{card === null ? childId : card.name}</strong>
        </div>
        {onBack !== undefined && (
          <button type="button" onClick={onBack}>К сводке</button>
        )}
      </header>

      {problem !== null && (
        <>
          <p className="auth-message error" role="alert">{problem}</p>
          <button
            type="button"
            onClick={() => { setProblem(null); setAttempt((value) => value + 1); }}
          >
            Повторить
          </button>
        </>
      )}

      {problem === null && card === null && <p role="status">Загружаю карточку…</p>}

      {card !== null && problem === null && (
        <>
          <p className="admin-stamp">
            <code>{card.childId}</code> · заведён {cardTime(card.createdAt)} ·
            {' '}{card.lastActivityAt === undefined
              ? 'ни разу не занимался'
              : `занимался ${cardTime(card.lastActivityAt)}`}
          </p>

          {/* База со схемой не той версии не читается и не мигрируется отчётом:
              миграция принадлежит первому настоящему заходу ребёнка. Пустая
              карточка вместо этой строки читалась бы как «ничего не делал». */}
          {card.state === 'stale' && (
            <p className="admin-empty">
              База ждёт первого захода: схема {card.schemaVersion}.
            </p>
          )}

          {card.state === 'failed' && (
            <p className="auth-message error" role="alert">
              База не открылась: {card.reason}
            </p>
          )}

          {card.state === 'read' && (
            <>
              <Gate gate={card.gate} />
              <section className="admin-panel">
                <h2>Темы и банк</h2>
                {card.topics.length === 0
                  ? <p className="admin-empty">Ни одной начатой темы</p>
                  : (
                    <ul className="admin-list">
                      {card.topics.map((topic) => (
                        <li key={topic.topicId}>
                          <strong>{topic.title ?? topic.topicId}</strong>{' '}
                          <code>{topic.topicId}</code> · mastery {topic.mastery.toFixed(2)} ·
                          {' '}ответов {topic.attempts} · годных {topic.bank.valid} ·
                          {' '}ждёт {topic.bank.pending} · занято {topic.bank.reserved} ·
                          {' '}брак {topic.bank.rejected} · выдано {topic.bank.used}
                          {topicNote(topic) === '' ? '' : ` · ${topicNote(topic)}`}
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
              <section className="admin-panel">
                <h2>Персональные разборы</h2>
                {card.materials.length === 0
                  ? <p className="admin-empty">Разборов не было</p>
                  : (
                    <ul className="admin-list">
                      {card.materials.map((material) => (
                        <li key={material.id}>
                          №{material.id} · <code>{material.topicId}</code> · {material.status} ·
                          {' '}заданий {material.tasks} · попыток {material.runs} ·
                          {' '}заведён {cardTime(material.createdAt)}
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
              <section className="admin-panel">
                <h2>Споры</h2>
                {card.disputes.length === 0
                  ? <p className="admin-empty">Споров не было</p>
                  : (
                    <ul className="admin-list">
                      {card.disputes.map((dispute) => (
                        <li key={dispute.id}>
                          №{dispute.id} · <code>{dispute.topicId}</code> · {dispute.status} ·
                          {' '}заведён {cardTime(dispute.createdAt)}
                          {dispute.resolvedAt === undefined
                            ? ''
                            : ` · закрыт ${cardTime(dispute.resolvedAt)}`}
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
              <section className="admin-panel">
                <h2>Боссы</h2>
                {card.bosses.length === 0
                  ? <p className="admin-empty">Боёв не было</p>
                  : (
                    <ul className="admin-list">
                      {card.bosses.map((boss) => (
                        <li key={boss.id}>
                          №{boss.id} · <code>{boss.topicId}</code> · {boss.status} ·
                          {' '}заданий {boss.tasks} · заведён {cardTime(boss.createdAt)}
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
