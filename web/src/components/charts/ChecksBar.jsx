import { segmentWidths } from '../../chartsGeometry.js';

// CI checks of a PR as proportional stretches: passed (green), pending (live),
// failed (red). Without any check only the track is drawn.
const KINDS = ['passed', 'pending', 'failed'];

export default function ChecksBar({ passed = 0, pending = 0, failed = 0, width = 52, height = 6, label }) {
  const segs = segmentWidths([passed, pending, failed], width, 1);
  return (
    <svg
      className="chart-checks"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <rect className="chart-track-idle" x={0} y={0} width={width} height={height} rx={height / 2} />
      {segs.map((s, i) => s.w > 0 && (
        <rect
          key={KINDS[i]}
          className={`chart-check-${KINDS[i]}`}
          x={s.x}
          y={0}
          width={s.w}
          height={height}
          rx={Math.min(height / 2, s.w / 2)}
        />
      ))}
    </svg>
  );
}
