import type { Subject } from './home-api';

export const SUBJECT_NAMES: Record<Subject, string> = {
  math: 'Математика',
  russian: 'Русский язык',
  english: 'Английский язык',
};

export const SUBJECTS = Object.keys(SUBJECT_NAMES) as Subject[];
