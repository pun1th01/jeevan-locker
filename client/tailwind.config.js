/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          900: '#0a192f',
          800: '#112240',
          500: '#64ffda',
        }
      }
    },
  },
  plugins: [],
}