type Props = {
  initials: string;
  size?: number;
  brand?: boolean;
};

export function Avatar({ initials, size = 28, brand }: Props) {
  return (
    <span
      className="inline-flex items-center justify-center font-semibold shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: brand ? "var(--color-brand-500)" : "var(--color-zinc-100)",
        color: brand ? "#fff" : "var(--color-zinc-700)",
        fontSize: size <= 28 ? 10.5 : 12,
        letterSpacing: "0.02em",
      }}
    >
      {initials}
    </span>
  );
}
