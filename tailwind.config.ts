import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        voyza: {
          bg: "#0f0f1a",
          card: "#1a1a2e",
          "card-hover": "#1e1e35",
          accent: "#4f8ef7",
          "accent-light": "#1a2a4f",
          border: "#2a2a3e",
          "border-accent": "#4f8ef7",
          success: "#4caf50",
          train: "#10b981",
          flight: "#4f8ef7",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
