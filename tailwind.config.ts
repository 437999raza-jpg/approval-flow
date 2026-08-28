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
    },
  },
  plugins: [],
};

export default config;
