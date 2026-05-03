import { createMemoryHistory, createRouter } from 'vue-router';

const routes = [
  { path: '/', component: { template: '<div>Home</div>' } },
];

export function createRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  });
}
