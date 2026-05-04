<script>
  import { page } from '$app/stores';
  let { data } = $props();
  let count = $state(0);
</script>

<svelte:head>
  <title>SvelteKit + Slate SSR</title>
</svelte:head>

<h1>SvelteKit + Slate SSR</h1>
<p>Current path: {$page.url.pathname}</p>
<p>Count: {count}</p>
<button onclick={() => count++}>+1</button>
<p>
  Try <a href="/api/hello">/api/hello</a> or <a href="/api/time">/api/time</a>
</p>

{#if data?.ip}
<h2>Server IP Detection</h2>
<p>IP: {data.ip.data?.ip ?? JSON.stringify(data.ip)}</p>
{:else}
<p>Loading IP...</p>
{/if}
