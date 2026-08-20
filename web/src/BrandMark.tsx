export interface BrandLinkProps {
  href?: string;
  label?: string;
}

/**
 * Маршрут одного учебного забега: от стартовой точки через два поворота к
 * финишной искре. SVG остаётся декоративным — назначение ссылки называет label.
 */
export function BrandLink({ href = '/', label = 'Эдукатор' }: BrandLinkProps) {
  return (
    <a className="brand" href={href} aria-label={label}>
      <svg
        className="brand-mark"
        viewBox="0 0 48 48"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="13" cy="35" r="3.25" fill="currentColor" />
        <path
          className="brand-mark-route"
          d="M13 35c5.8 0 7-3.3 7-7.5 0-5.2 3.5-8.5 8.5-8.5H32"
        />
        <path
          className="brand-mark-finish"
          d="M36 7.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"
          fill="currentColor"
        />
      </svg>
    </a>
  );
}
