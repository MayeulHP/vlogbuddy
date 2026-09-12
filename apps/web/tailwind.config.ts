import type { Config } from "tailwindcss";

/**
 * ROLLCALL — indie editing room meets editorial magazine.
 *
 * Warm paper, near-black ink, one signal colour (film red). Corners are square
 * by default: this is a design of hairlines, rules and registration marks, not
 * of soft cards. Radii above 2px are reserved for things that are genuinely
 * round — avatars, dots, sprockets.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /** Paper stock: a cool bone, closer to newsprint than to cream. */
        paper: {
          50: "#FAFAF8",
          100: "#F0F0EC",
          200: "#E6E6E1",
          300: "#D8D8D1",
          400: "#BFBFB6",
          500: "#A2A29A",
        },
        /** Ink. Neutral, very slightly blue — press black, not brown. */
        ink: {
          950: "#08090A",
          900: "#111315",
          850: "#181A1D",
          800: "#212429",
          700: "#323639",
          600: "#4A4F54",
          500: "#6C7279",
          400: "#8D939A",
          300: "#B0B5BB",
          200: "#D3D7DB",
        },
        /** Scarlet. A hard printed red — the cut line, and nothing else. */
        signal: {
          900: "#3E0710",
          800: "#610B18",
          700: "#8A0F1F",
          600: "#AE1228",
          500: "#CE1B31",
          400: "#E24457",
          300: "#EC8391",
          200: "#EAC8CC",
          100: "#F7E9EA",
        },
        /** Grease-pencil yellow — warnings, marks-in-the-margin. */
        tape: {
          600: "#8C7412",
          500: "#BE9E1C",
          400: "#DCBE4E",
          200: "#F1E4B0",
        },
        /** Print green — "ready", "synced". Deliberately muted. */
        leader: {
          600: "#20604A",
          500: "#2E7D60",
          400: "#5AA084",
        },
      },
      fontFamily: {
        display: ['"Bodoni Moda"', "Didot", '"Bodoni MT"', "Georgia", "serif"],
        sans: ["Archivo", "Helvetica Neue", "Helvetica", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      letterSpacing: {
        label: "0.14em",
        wordmark: "-0.03em",
      },
      borderRadius: {
        DEFAULT: "0px",
        sm: "2px",
        md: "3px",
        lg: "4px",
      },
      boxShadow: {
        /** A print lifting off the page — tight, warm, never glowy. */
        print: "0 1px 0 rgba(17,19,21,0.04), 0 18px 30px -22px rgba(17,19,21,0.45)",
        lift: "0 2px 0 rgba(17,19,21,0.05), 0 34px 48px -28px rgba(17,19,21,0.5)",
        cell: "inset 0 0 0 1px rgba(17,19,21,0.08)",
        deck: "0 40px 60px -30px rgba(0,0,0,0.8)",
      },
      backgroundImage: {
        /** Sprocket perforations for film-strip edges. */
        sprocket:
          "repeating-linear-gradient(90deg, transparent 0 6px, currentColor 6px 14px, transparent 14px 20px)",
        /** 8px editorial grid, for light-table surfaces. */
        grid: "linear-gradient(rgba(17,19,21,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(17,19,21,0.05) 1px, transparent 1px)",
        hatch:
          "repeating-linear-gradient(45deg, rgba(17,19,21,0.07) 0 1px, transparent 1px 6px)",
      },
      animation: {
        "fade-in": "fadeIn 0.18s ease-out both",
        rise: "rise 0.34s cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-up": "slideUp 0.26s cubic-bezier(0.22, 1, 0.36, 1) both",
        punch: "punch 0.26s cubic-bezier(0.34, 1.56, 0.64, 1)",
        stamp: "stamp 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        flicker: "flicker 3.2s steps(1, end) infinite",
        sweep: "sweep 1.6s linear infinite",
        "strip-scroll": "stripScroll 22s linear infinite",
        "grain-drift": "grainDrift 1.1s steps(4, end) infinite",
        "pulse-dot": "pulseDot 1.8s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        rise: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        punch: {
          "0%": { transform: "scale(0.86)" },
          "55%": { transform: "scale(1.1)" },
          "100%": { transform: "scale(1)" },
        },
        stamp: {
          "0%": { opacity: "0", transform: "scale(1.5) rotate(-9deg)" },
          "60%": { opacity: "1", transform: "scale(0.96) rotate(-5deg)" },
          "100%": { opacity: "1", transform: "scale(1) rotate(-6deg)" },
        },
        flicker: {
          "0%, 96%": { opacity: "1" },
          "97%": { opacity: "0.82" },
          "98%": { opacity: "1" },
          "99%": { opacity: "0.9" },
        },
        sweep: { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } },
        stripScroll: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        grainDrift: {
          "0%": { transform: "translate(0, 0)" },
          "25%": { transform: "translate(-2%, 1%)" },
          "50%": { transform: "translate(1%, -2%)" },
          "75%": { transform: "translate(-1%, -1%)" },
          "100%": { transform: "translate(0, 0)" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
