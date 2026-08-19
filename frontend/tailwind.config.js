/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Semantic tokens backed by CSS variables (see index.css). Both themes define
      // every one of them, so components never hardcode a light or dark colour.
      colors: {
        app: "var(--c-app)",
        surface: {
          DEFAULT: "var(--c-surface)",
          2: "var(--c-surface-2)",
          3: "var(--c-surface-3)",
          solid: "var(--c-surface-solid)",
        },
        hairline: {
          DEFAULT: "var(--c-hairline)",
          strong: "var(--c-hairline-strong)",
        },
        fg: {
          DEFAULT: "var(--c-fg)",
          muted: "var(--c-fg-muted)",
          dim: "var(--c-fg-dim)",
        },
        accent: {
          DEFAULT: "var(--c-accent)",
          fg: "var(--c-accent-fg)",
          soft: "var(--c-accent-soft)",
          ring: "var(--c-accent-ring)",
        },
        edge: "var(--c-edge)",
      },
      borderRadius: {
        tile: "16px",
      },
      fontSize: {
        // Tightened scale: meta / body / title. Nothing else needed.
        "2xs": ["10px", { lineHeight: "1.35" }],
        xs: ["11px", { lineHeight: "1.45" }],
        sm: ["12.5px", { lineHeight: "1.5" }],
        base: ["13.5px", { lineHeight: "1.55" }],
        lg: ["15px", { lineHeight: "1.45" }],
        xl: ["18px", { lineHeight: "1.35" }],
      },
      boxShadow: {
        tile: "var(--shadow-tile)",
        pop: "var(--shadow-pop)",
      },
      backdropBlur: {
        tile: "18px",
      },
    },
  },
  plugins: [],
};
