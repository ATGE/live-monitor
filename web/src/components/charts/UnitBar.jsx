import { unitCells } from '../../chartsGeometry.js';

// Progress by unit (subagents, steps): one cell per unit up to 24, then three
// proportional stretches. done = --done-cell, running = --live, pending = dim.
export default function UnitBar({ done = 0, running = 0, total = 0, width = 120, height = 8, label }) {
  const { cells } = unitCells(done, running, total, width, 2);
  return (
    <svg
      className="chart-unitbar"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {cells.map((c, i) => (
        <rect
          key={i}
          className={`chart-cell-${c.state}`}
          x={c.x}
          y={0}
          width={c.w}
          height={height}
          rx={Math.min(2, c.w / 2, height / 2)}
        />
      ))}
    </svg>
  );
}
