/** @type {import('./$types').PageServerLoad} */
export async function load({ fetch }) {
  const res = await fetch('https://check.adspower.com/sys/config/ip/get-visitor-ip');
  const data = await res.json();
  return {
    ip: data,
  };
}
