import { defineConfig } from 'vitest/config';
// Testes da plataforma; o Console tem os próprios (npm test dentro de console/).
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'] } });
