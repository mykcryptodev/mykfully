/** X-style circular character counter. */
export function CharCounter({ weighted, max }: { weighted: number; max: number }) {
  const remaining = max - weighted;
  const warn = remaining <= 20;
  const over = remaining < 0;
  const farOver = remaining < -9;
  const size = warn ? 30 : 20;
  const stroke = 2;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const progress = Math.min(weighted / max, 1);
  const color = over ? "var(--danger)" : warn ? "var(--warn)" : "var(--accent)";
  const label = `${remaining} characters remaining`;

  return (
    <div
      className="relative flex h-[30px] w-[30px] items-center justify-center"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={weighted}
      title={`${weighted.toLocaleString()} / ${max.toLocaleString()}`}
    >
      {!farOver && (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 transition-all duration-150">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={c}
            strokeDashoffset={c * (1 - progress)}
            strokeLinecap="round"
          />
        </svg>
      )}
      {warn && (
        <span
          className={`absolute inset-0 flex items-center justify-center text-[13px] tabular-nums ${
            over ? "text-danger" : "text-muted"
          }`}
        >
          {remaining}
        </span>
      )}
    </div>
  );
}
