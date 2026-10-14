import { ringDash } from '../../chartsGeometry.js';

// Thin meter for the detail panels: dim track in the tone's hue, lit fill.
// ringDash is reused only for its 0..100 clamp of the percentage.
export default function MiniBar({ percent = 0, tone = 'live', width = 56, height = 6, label }) {
  const fill = (ringDash(percent, 1).percent / 100) * width;
  return (
    <svg
      className={`chart-minibar chart-tone-${tone}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <rect className="chart-track-fill" x={0} y={0} width={width} height={height} rx={height / 2} />
      {fill > 0 && (
        <rect className="chart-fill-solid" x={0} y={0} width={Math.max(fill, height)} height={height} rx={height / 2} />
      )}
    </svg>
  );
}
