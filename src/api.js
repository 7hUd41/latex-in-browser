// Thin wrapper around the backend API.

async function request(method, url, body) {
  const opts = { method, headers: { 'X-Editor': '1' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = '/login'; throw new Error('not logged in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  docs: () => request('GET', '/api/docs'),
  create: (name, from) => request('POST', '/api/docs', { name, from }),
  rename: (doc, name) => request('POST', `/api/docs/${enc(doc)}/rename`, { name }),
  tree: (doc) => request('GET', `/api/docs/${enc(doc)}/tree`),
  read: (doc, path) => request('GET', `/api/docs/${enc(doc)}/file?path=${enc(path)}`),
  write: (doc, path, content, create = false) =>
    request('PUT', `/api/docs/${enc(doc)}/file?path=${enc(path)}`, { content, create }),
  mkdir: (doc, path) => request('POST', `/api/docs/${enc(doc)}/mkdir`, { path }),
  compile: (doc) => request('POST', `/api/docs/${enc(doc)}/compile`, {}),
  status: (doc) => request('GET', `/api/docs/${enc(doc)}/status`),
  commit: (doc, message) => request('POST', `/api/docs/${enc(doc)}/commit`, { message }),
  log: (doc) => request('GET', `/api/docs/${enc(doc)}/log`),
  show: (doc, hash) => request('GET', `/api/docs/${enc(doc)}/show?hash=${enc(hash)}`),
  restore: (doc, hash, force) => request('POST', `/api/docs/${enc(doc)}/restore`, { hash, force }),
  syncView: (doc, path, line, column) =>
    request('GET', `/api/docs/${enc(doc)}/sync-view?path=${enc(path)}&line=${line}&column=${column}`),
  syncEdit: (doc, page, x, y) => request('GET', `/api/docs/${enc(doc)}/sync-edit?page=${page}&x=${x}&y=${y}`),
  logout: () => request('POST', '/api/logout', {}),
  pdfUrl: (doc) => `/api/docs/${enc(doc)}/pdf?t=${Date.now()}`,
};
