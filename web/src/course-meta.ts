export interface CourseMeta {
  courseId: string;
  title: string;
  grade: string;
  revision?: number | null;
}

/** Короткая метка не зависит от языка и остаётся осмысленной без иконки курса. */
export function courseInitials(title: string): string {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1
    ? Array.from(words[0] as string).slice(0, 2)
    : words.slice(0, 2).map((word) => Array.from(word)[0] as string);
  return letters.join('').toLocaleUpperCase('ru-RU');
}

/** Один course ID всегда получает один спокойный, достаточно тёмный акцент. */
export function courseColor(courseId: string): string {
  let hash = 2166136261;
  for (const character of courseId) {
    hash ^= character.codePointAt(0) as number;
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${String((hash >>> 0) % 360)} 48% 38%)`;
}

export function courseById(courses: readonly CourseMeta[], courseId: string): CourseMeta {
  return courses.find((course) => course.courseId === courseId) ?? {
    courseId,
    title: courseId,
    grade: '',
  };
}
