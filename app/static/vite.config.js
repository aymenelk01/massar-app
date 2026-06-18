import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve('src/index.html'),
        login: resolve('src/login.html'),
        loginTeacher: resolve('src/login-teacher.html'),
        loginAdmin: resolve('src/login-admin.html'),
        results: resolve('src/results.html'),
        teacher: resolve('src/teacher.html'),
        admin: resolve('src/admin.html'),
      }
    }
  }
});
