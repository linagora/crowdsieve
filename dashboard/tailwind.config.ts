import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        crowdsec: {
          primary: '#1a1a2e',
          secondary: '#16213e',
          accent: '#e94560',
        },
      },
    },
  },
  plugins: [],
};

export default config;
