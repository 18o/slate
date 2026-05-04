<template>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vue + Slate SSR</title>
  </head>
  <body>
    <h1>Vue + Slate SSR</h1>
    <p>Current path: {{ $route.path }}</p>
    <p>Count: {{ count }}</p>
    <button @click="count++">+1</button>
    <p>
      Try <a href="/api/hello">/api/hello</a> or <a href="/api/time">/api/time</a>
    </p>
  </body>
  </html>
</template>

<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>
