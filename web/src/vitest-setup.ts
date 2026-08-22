import '@testing-library/jest-dom/vitest';

// dnd-kit создаёт наблюдатель при загрузке модуля. JSDOM его пока не
// реализует; для тестов сортировки достаточно бездействующего наблюдателя.
if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
