import { arcPath, slotArcs } from '../../chartsGeometry.js';

// One arc per parallel slot, with an angular gap between them. Occupied slots
// are --live with a soft glow (charts.css); free ones are a dim track. Static
// on purpose: nothing animates, so there is no reduced-motion case.
export default function SlotRing({ used = 0, total = 0, size = 50, stroke = 6, gapDeg = 9, label }) {
  const r = (size - stroke) / 2;
  const mid = size / 2;
  const lit = Math.max(0, Math.floor(Number.isFinite(used) ? used : 0));
  return (
    <svg
      className="chart-slotring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
    >
      {slotArcs(total, r, gapDeg).map((a) => (
        <path
          key={a.index}
          className={a.index < lit ? 'chart-slot-on' : 'chart-slot-off'}
          d={arcPath(mid, mid, r, a.a0, a.a1)}
          fill="none"
          strokeWidth={stroke}
        />
      ))}
    </svg>
  );
}
