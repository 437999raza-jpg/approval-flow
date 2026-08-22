"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState } from "react";

export function SearchInput({
  defaultValue,
  placeholder = "Search vendor, file, invoice #...",
}: {
  defaultValue: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(defaultValue);

  function submit(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("q", next);
    else params.delete("q");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <input
      type="search"
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && submit(value)}
      onBlur={() => submit(value)}
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
    />
  );
}
