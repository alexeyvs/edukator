import { describe, expect, it } from 'vitest';
import { parseFrpManifest, readFrpManifest } from '../scripts/frp-manifest.js';

const entry = {
  subject: 'matematika', title: 'Математика', level: 'ooo',
  url: 'https://edsoo.ru/wp-content/uploads/2025/07/2025_ooo_frp_matematika-5-9_baza.pdf',
  sha256: 'a'.repeat(64), grades: [5, 6, 7, 8, 9], courseId: { 7: 'math' },
};

describe('parseFrpManifest', () => {
  it('разбирает исправный манифест', () => {
    expect(parseFrpManifest([entry])[0]?.subject).toBe('matematika');
  });

  it('отвергает отпечаток не той длины', () => {
    expect(() => parseFrpManifest([{ ...entry, sha256: 'abc' }])).toThrow(/sha256/u);
  });

  it('отвергает адрес не по https', () => {
    expect(() => parseFrpManifest([{ ...entry, url: 'http://edsoo.ru/x.pdf' }])).toThrow(/https/u);
  });

  it('отвергает класс, которого нет в grades', () => {
    expect(() => parseFrpManifest([{ ...entry, courseId: { 4: 'math' } }])).toThrow(/4/u);
  });

  it('отвергает повтор предмета и уровня', () => {
    expect(() => parseFrpManifest([entry, entry])).toThrow(/matematika/u);
  });

  it('отвергает пустой список классов', () => {
    expect(() => parseFrpManifest([{ ...entry, grades: [], courseId: {} }])).toThrow(/grades/u);
  });
});

describe('readFrpManifest', () => {
  it('читает манифест репозитория и находит десять предметов', () => {
    const subjects = new Set(readFrpManifest().map((source) => source.subject));
    expect(subjects.size).toBe(10);
  });

  it('у каждой записи манифеста классы лежат в 5..11', () => {
    for (const source of readFrpManifest()) {
      for (const grade of source.grades) {
        expect(grade).toBeGreaterThanOrEqual(5);
        expect(grade).toBeLessThanOrEqual(11);
      }
    }
  });

  it('legacy-курсы названы ровно для 7 класса', () => {
    // Порядок записей манифеста — не предмет договора, поэтому сравниваются
    // множества, а не массивы: перестановка строк файла не должна красить тест.
    const named = readFrpManifest().flatMap((source) => Object.entries(source.courseId ?? {}));
    expect(named).toHaveLength(3);
    expect(new Set(named.map(([grade]) => grade))).toEqual(new Set(['7']));
    expect(new Set(named.map(([, id]) => id))).toEqual(new Set(['math', 'russian', 'english']));
  });
});
