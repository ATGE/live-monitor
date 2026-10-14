import { ringDash } from '../../chartsGeometry.js';

// Gauge ring. The track is a dim step of the same tone (charts.css); the lit
// arc is a stroke-dasharray on a circle rotated to start at 12 o'clock, which
// keeps the round cap exact.
export default function Ring({ percent = 0, size = 50, stroke = 6, tone = 'live', label }) {
  const r = (size - stroke) / 2;
  const mid = size / 2;
  const { dash, circumference } = ringDash(percent, r);
  return (
    <svg
      className={`chart-ring chart-tone-${tone}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
    >
      <circle className="chart-track" cx={mid} cy={mid} r={r} fill="none" strokeWidth={stroke} />
      {dash > 0 && (
        <circle
          className="chart-fill"
          cx={mid}
          cy={mid}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${mid} ${mid})`}
        />
      )}
    </svg>
  );
}
