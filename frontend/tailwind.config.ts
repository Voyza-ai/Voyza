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
          bg: "#FAFAFA",
          card: "#ffffff",
          "card-hover": "#f5f5f7",
          accent: "#2e6bc4",
          "accent-light": "#e8f0fe",
          border: "#e5e7eb",
          "border-accent": "#2e6bc4",
          success: "#4caf50",
          train: "#22c088",
          flight: "#2e6bc4",
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
