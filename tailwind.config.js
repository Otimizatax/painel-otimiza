/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./*.{js,jsx}"],
  theme: { extend: { fontFamily: {
    serif: ['Georgia','Cambria','Times New Roman','serif'],
    sans: ['Inter','system-ui','Arial','sans-serif'],
  } } },
  plugins: [],
};
