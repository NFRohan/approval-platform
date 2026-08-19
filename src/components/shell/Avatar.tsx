type Props = {
  initials: string;
  size?: number;
  pink?: boolean;
};

export function Avatar({ initials, size = 28, pink }: Props) {
  return (
    <span
      className="inline-flex items-center justify-center font-semibold shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: pink ? "var(--color-brand-500)" : "var(--color-zinc-100)",
        color: pink ? "#fff" : "var(--color-zinc-700)",
        fontSize: size <= 28 ? 10.5 : 12,
        letterSpacing: "0.02em",
      }}
    >
      {initials}
    </span>
  );
}
