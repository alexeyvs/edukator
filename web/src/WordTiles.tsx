import { DragDropProvider } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { useEffect, useRef, useState } from 'react';

interface Tile {
  id: string;
  text: string;
}

export interface WordTilesProps {
  taskId: number;
  words: readonly string[];
  answer: string;
  onAnswerChange: (answer: string) => void;
  readOnly?: boolean;
}

function sourceTiles(taskId: number, words: readonly string[]): Tile[] {
  return words.map((text, index) => ({ id: `${taskId}-word-${index}`, text }));
}

/** В результате порядок восстанавливается по строке ученика, включая дубли слов. */
function initialTiles(taskId: number, words: readonly string[], answer: string): Tile[] {
  const source = sourceTiles(taskId, words);
  if (answer.trim() === '') return source;
  const available = new Map<string, Tile[]>();
  for (const tile of source) available.set(tile.text, [...(available.get(tile.text) ?? []), tile]);
  const ordered: Tile[] = [];
  for (const word of answer.split(' ')) {
    const tile = available.get(word)?.shift();
    if (tile === undefined) return source;
    ordered.push(tile);
  }
  return ordered.length === source.length ? ordered : source;
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  const result = [...items];
  const [item] = result.splice(from, 1);
  if (item !== undefined) result.splice(to, 0, item);
  return result;
}

interface SortableTileProps {
  tile: Tile;
  index: number;
  total: number;
  readOnly: boolean;
  onMove: (from: number, to: number) => void;
}

function SortableTile({ tile, index, total, readOnly, onMove }: SortableTileProps) {
  const { ref, handleRef, isDragging } = useSortable({ id: tile.id, index, disabled: readOnly });
  return (
    <li ref={ref} className={`word-tile${isDragging ? ' dragging' : ''}`}>
      <button
        ref={handleRef}
        className="word-tile-handle"
        type="button"
        disabled={readOnly}
        aria-label={`Перетащить слово «${tile.text}», позиция ${index + 1} из ${total}`}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <span className="word-tile-text">{tile.text}</span>
      {!readOnly && (
        <span className="word-tile-buttons" data-no-drag>
          <button
            type="button"
            aria-label={`Передвинуть «${tile.text}» влево`}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >←</button>
          <button
            type="button"
            aria-label={`Передвинуть «${tile.text}» вправо`}
            disabled={index === total - 1}
            onClick={() => onMove(index, index + 1)}
          >→</button>
        </span>
      )}
    </li>
  );
}

export function WordTiles({
  taskId,
  words,
  answer,
  onAnswerChange,
  readOnly = false,
}: WordTilesProps) {
  const [tiles, setTiles] = useState(() => initialTiles(taskId, words, answer));
  const [announcement, setAnnouncement] = useState('');
  const onAnswerChangeRef = useRef(onAnswerChange);
  onAnswerChangeRef.current = onAnswerChange;
  const wordsKey = words.join('\u0000');

  useEffect(() => {
    const next = initialTiles(taskId, words, readOnly ? answer : '');
    setTiles(next);
    setAnnouncement('');
    onAnswerChangeRef.current(next.map((tile) => tile.text).join(' '));
    // `answer` меняется после каждого нашего движения. Он нужен только при
    // монтировании результата, а не как второй источник сортируемого состояния.
  }, [taskId, wordsKey, readOnly]);

  function commit(from: number, to: number): void {
    if (readOnly || from === to) return;
    setTiles((current) => {
      const next = move(current, from, to);
      const moved = next[to];
      onAnswerChangeRef.current(next.map((tile) => tile.text).join(' '));
      setAnnouncement(moved === undefined ? '' : `Слово «${moved.text}» теперь на позиции ${to + 1}.`);
      return next;
    });
  }

  return (
    <fieldset className="word-order-field" aria-describedby={`word-order-help-${taskId}`}>
      <legend>Собери предложение</legend>
      <p id={`word-order-help-${taskId}`} className="word-order-help">
        Перетаскивай слова за ручку или используй стрелки на карточке.
      </p>
      <DragDropProvider
        onDragEnd={(event) => {
          if (event.canceled) return;
          const { source } = event.operation;
          if (isSortable(source)) commit(source.initialIndex, source.index);
        }}
      >
        <ol className="word-tiles" aria-label="Порядок слов">
          {tiles.map((tile, index) => (
            <SortableTile
              key={tile.id}
              tile={tile}
              index={index}
              total={tiles.length}
              readOnly={readOnly}
              onMove={commit}
            />
          ))}
        </ol>
      </DragDropProvider>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </fieldset>
  );
}
