import { createSSRApp } from 'vue';
import App from './App.vue';
import { createRouter } from './router';

export function createApp({ url }) {
  const app = createSSRApp(App);
  const router = createRouter();
  router.push(url);
  app.use(router);
  return app;
}
