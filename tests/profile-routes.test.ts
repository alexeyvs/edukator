import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildGenerationPrompt } from '../server/codex/prompt.js';
import { runWarmupCycle } from '../server/codex/worker.js';
import { loadCurriculum, type TopicGraph } from '../server/curriculum.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { buildServer } from '../server/index.js';
import {
  registerProfileRoutes,
  registerUnavailableProfile,
} from '../server/routes/profile.js';

function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(
      join(dir, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: [{
          id: `${subject}.a`,
          subject,
          title: `Тема ${subject}`,
          exam_weight: 3,
          difficulty: 2,
          prereqs: [],
          answer_format: 'number',
          prompt_seed: `Спрашивай по теме ${subject}.`,
        }],
      }),
    );
  }
}

describe('маршруты профиля', () => {
  let tempDir: string;
  let curriculumDir: string;
  let seedDir: string;
  let personaPath: string;
  let app: FastifyInstance;
  let db: Database;
  let graph: TopicGraph;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-profile-routes-'));
    curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    personaPath = join(tempDir, 'persona.md');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    writeFileSync(personaPath, [
      'Общие правила персоны.',
      '',
      '## Знакомство',
      '',
      'Я напарник. Меня можно переименовать.',
      '',
      '## Тон',
      '',
      'Коротко и без канцелярита.',
    ].join('\n'));
    process.env.EDUKATOR_DB = join(tempDir, 'profile-routes.db');

    app = buildServer(curriculumDir, { seedDir, personaPath });
    await app.ready();
    db = openDatabase(process.env.EDUKATOR_DB);
    graph = loadCurriculum(curriculumDir);
  });

  afterEach(async () => {
    db.close();
    await app.close();
    delete process.env.EDUKATOR_DB;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('сохраняет профиль, отдаёт знакомство и подставляет интересы в следующий промпт', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      payload: {
        name: 'Тимофей',
        interests: ['скейт', 'кот «Пират»'],
        examDate: '2027-05-20',
        partnerName: 'Кекс',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      name: 'Тимофей',
      interests: ['скейт', 'кот «Пират»'],
      examDate: '2027-05-20',
      partnerName: 'Кекс',
      introduction: 'Я напарник. Меня можно переименовать.',
    });

    const read = await app.inject({ method: 'GET', url: '/api/profile' });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(saved.json());

    let prompt = '';
    await runWarmupCycle({
      db,
      graph,
      topics: 1,
      threshold: 1,
      target: 1,
      maxBatches: 1,
      produce: vi.fn(async (request) => {
        prompt = buildGenerationPrompt({
          topic: request.topic,
          difficulty: request.difficulty,
          profile: request.profile,
          persona: 'Тестовая персона.',
          count: 1,
        });
        return [{
          instruction: 'Сколько будет 2 + 2?', material: '', material_format: 'none' as const, choices: [],
          answer: '4',
          accept: ['4'],
          hint: 'Сложи две двойки.',
          explain: '2 + 2 = 4.',
          joke: 'Калькулятор может отдохнуть.',
          difficulty: 2,
        }];
      }),
    });
    expect(prompt).toContain('"\u0438\u043d\u0442\u0435\u0440\u0435\u0441\u044b": [');
    expect(prompt).toContain('"\u0441\u043a\u0435\u0439\u0442"');
    expect(prompt).toContain('"\u043a\u043e\u0442 «\u041f\u0438\u0440\u0430т»"');
  });

  it('отвергает мусор в дате и не меняет профиль', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/profile' })).json();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      payload: { examDate: '20 мая' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/exam_date/u) });
    expect((await app.inject({ method: 'GET', url: '/api/profile' })).json()).toEqual(before);
  });

  it('отвергает поля неверного типа и неизвестные поля', async () => {
    const brokenBodies = [
      null,
      { extra: true },
      { name: 13 },
      { partnerName: false },
      { interests: 'скейт' },
      { interests: ['скейт', 13] },
      { examDate: 20270520 },
    ];

    for (const payload of brokenBodies) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        payload: payload as Record<string, unknown>,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('отвергает слишком большой профиль и не сохраняет его', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/profile' })).json();
    for (const payload of [
      { name: 'я'.repeat(201) },
      { partnerName: 'н'.repeat(201) },
      { interests: Array.from({ length: 13 }, (_, index) => `интерес ${index}`) },
      { interests: ['и'.repeat(201)] },
    ]) {
      const response = await app.inject({ method: 'PUT', url: '/api/profile', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/profile' })).json()).toEqual(before);
  });

  it('считает отсутствующую персону ошибкой настройки, а не пусым текстом', async () => {
    const broken = buildServer(curriculumDir, {
      seedDir,
      personaPath: join(tempDir, 'missing-persona.md'),
    });
    await broken.ready();
    try {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const response = await broken.inject({ method: 'GET', url: '/api/profile' });
      stderr.mockRestore();

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Внутренняя ошибка сервера' });
    } finally {
      await broken.close();
    }
  });

  it('отвергает персону без раздела знакомства', async () => {
    const withoutIntroduction = join(tempDir, 'persona-without-introduction.md');
    writeFileSync(withoutIntroduction, 'Только правила тона.');
    const broken = buildServer(curriculumDir, { seedDir, personaPath: withoutIntroduction });
    await broken.ready();
    try {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const response = await broken.inject({ method: 'GET', url: '/api/profile' });
      stderr.mockRestore();
      expect(response.statusCode).toBe(500);
    } finally {
      await broken.close();
    }
  });

  it('отдаёт 503 на обоих URL, если соединение отвязано или профиль не поднялся', async () => {
    const detached = Fastify();
    registerProfileRoutes(detached, { db, personaPath, available: () => false });
    await detached.ready();
    const unavailable = Fastify();
    registerUnavailableProfile(unavailable, 'база недоступна');
    await unavailable.ready();
    try {
      for (const instance of [detached, unavailable]) {
        expect((await instance.inject({ method: 'GET', url: '/api/profile' })).statusCode)
          .toBe(503);
        expect((await instance.inject({ method: 'PUT', url: '/api/profile', payload: {} })).statusCode)
          .toBe(503);
      }
    } finally {
      await detached.close();
      await unavailable.close();
    }
  });

  it('использует репозиторную персону без тестовой подмены пути', async () => {
    const direct = Fastify();
    registerProfileRoutes(direct, { db });
    await direct.ready();
    try {
      const response = await direct.inject({ method: 'GET', url: '/api/profile' });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { introduction: string }).introduction).toContain('твой напарник');
    } finally {
      await direct.close();
    }
  });
});
