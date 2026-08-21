function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SIZES = {
  sm: "h-6 w-6 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-14 w-14 text-lg",
};

export function Avatar({
  name,
  photoUrl,
  size = "md",
}: {
  name: string;
  photoUrl?: string | null;
  size?: keyof typeof SIZES;
}) {
  const dim = SIZES[size];
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photoUrl} alt={name} className={`${dim} rounded-full object-cover`} />;
  }
  return (
    <div
      className={`${dim} flex flex-none items-center justify-center rounded-full bg-emerald-600 font-medium text-white`}
    >
      {initialsFor(name)}
    </div>
  );
}
