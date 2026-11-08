export async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(v => v.toString(16).padStart(2, '0')).join('');
}
