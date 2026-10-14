import { sparkPoints } from '../../chartsGeometry.js';

// Line of recent values with a dot on the latest one. With fewer than two
// values only the axis is drawn: a line through one point says nothing.
export default function Sparkline({ values = [], width = 96, height = 24, label }) {
  const { line, area, last } = sparkPoints(values, width, height, 4);
  return (
    <svg
      className="chart-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <line className="chart-axis" x1={4} x2={width - 4} y1={height - 0.5} y2={height - 0.5} />
      {last && (
        <>
          <path className="chart-spark-area" d={area} />
          <polyline
            className="chart-spark-line"
            points={line}
            fill="none"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle className="chart-spark-dot" cx={last.x} cy={last.y} r="3" />
        </>
      )}
    </svg>
  );
}
