// Pemanggil API backend.

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // respons kosong
  }
  if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('auth-required'));
  if (!res.ok) throw new ApiError(data?.error || `Gagal memuat (kode ${res.status})`, res.status);
  return data;
}

export const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null));
  const str = s.toString();
  return str ? `?${str}` : '';
};
