import { columnRects } from '../../chartsGeometry.js';

// Small bar series (completions per day). Past columns are muted, the last one
// (today) is the series colour; a zero day is a 1 px base mark.
export default function SparkColumns({ values = [], width = 84, height = 18, label }) {
  const rects = columnRects(values, width, height, 2);
  return (
    <svg
      className="chart-cols"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {rects.map((c, i) => (
        <rect
          key={i}
          className={c.last && !c.zero ? 'chart-col-now' : 'chart-col-past'}
          x={c.x}
          y={c.y}
          width={c.w}
          height={c.h}
          rx={c.zero ? 0 : Math.min(1.5, c.w / 2)}
        />
      ))}
    </svg>
  );
}
