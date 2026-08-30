import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      // ufirst brand tokens (see ufirst_brand_brief.md) — additive, not a
      // replacement for the existing slate/blue palette used throughout
      // the app. New/updated screens adopt these incrementally.
      colors: {
        "brand-ink": "#091727",
        "brand-navy": "#122A4A",
        "brand-green": "#57A14C",
        "brand-green-dark": "#3E7D36",
        "brand-green-light": "#7CC470",
        "brand-mist": "#F2F5F8",
        "brand-line": "#D9E0E8",
        "brand-muted": "#5A6B7E",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Arial", "sans-serif"],
        display: ["var(--font-archivo)", "Arial", "sans-serif"],
      },
      // Soft, layered elevation tinted with brand-ink instead of flat
      // black — reads as "lifted paper" rather than a generic drop shadow.
      // -1 is a resting card edge, -2 a hovered/popover surface, -3 a modal.
      boxShadow: {
        "elevation-1": "0 1px 2px 0 rgba(9,23,39,0.04), 0 1px 1px 0 rgba(9,23,39,0.03)",
        "elevation-2": "0 4px 12px -2px rgba(9,23,39,0.10), 0 2px 4px -2px rgba(9,23,39,0.04)",
        "elevation-3": "0 16px 32px -8px rgba(9,23,39,0.18), 0 4px 8px -4px rgba(9,23,39,0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
