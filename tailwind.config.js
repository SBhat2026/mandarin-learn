/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Warm-neutral canvas + a single calm jade accent used sparingly.
        ink: {
          DEFAULT: '#1c1917', // stone-900, primary text + buttons
          soft: '#57534e',    // stone-600, secondary text
          faint: '#a8a29e',   // stone-400, tertiary
        },
        jade: {
          50: '#eef7f4', 100: '#d6ece5', 200: '#a9d8c9',
          400: '#3f9e86', 500: '#2f8a72', 600: '#1f7a63', 700: '#155e4c',
        },
        line: '#eae7e2', // hairline border
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Inter"', 'sans-serif'],
        hanzi: ['"Songti SC"', '"Noto Serif SC"', '"Source Han Serif SC"', 'STSong', 'serif'],
        hanziSans: ['"PingFang SC"', '"Noto Sans SC"', '"Hiragino Sans GB"', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(28,25,23,0.04), 0 8px 24px -12px rgba(28,25,23,0.12)',
        lift: '0 2px 4px rgba(28,25,23,0.05), 0 20px 40px -20px rgba(28,25,23,0.18)',
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.25rem', '3xl': '1.75rem' },
      letterSpacing: { tightish: '-0.015em' },
      keyframes: {
        rise: { '0%': { opacity: 0, transform: 'translateY(6px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        fade: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
      },
      animation: {
        rise: 'rise 0.35s cubic-bezier(0.22,1,0.36,1)',
        fade: 'fade 0.4s ease',
      },
    },
  },
  plugins: [],
};
