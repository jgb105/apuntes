// Portadas de libretas: dibujos propios (SVG) listos para elegir, o una imagen subida por el usuario.
// Valor guardado en la libreta: "preset:<clave>" o "file:<ruta del adjunto>".

const svg = (body, bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">${bg}${body}</svg>`;
const grad = (id, a, b, dir = 'x1="0" y1="0" x2="0" y2="1"') =>
  `<defs><linearGradient id="${id}" ${dir}><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#${id})"/>`;

function stars(n, seed, color = '#fff') {
  let s = seed, out = '';
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < n; i++) out += `<circle cx="${(rnd() * 100).toFixed(1)}" cy="${(rnd() * 100).toFixed(1)}" r="${(rnd() * 1.1 + .3).toFixed(2)}" fill="${color}" opacity="${(rnd() * .6 + .4).toFixed(2)}"/>`;
  return out;
}

export const PRESETS = {
  galaxia: { name: 'Galaxia', svg: svg(`<ellipse cx="55" cy="50" rx="38" ry="12" fill="#c9b8ff" opacity=".35" transform="rotate(-25 55 50)"/><ellipse cx="55" cy="50" rx="18" ry="6" fill="#fff4e0" opacity=".7" transform="rotate(-25 55 50)"/>${stars(45, 7)}`, grad('g', '#0b0820', '#2b1c55', 'x1="0" y1="0" x2="1" y2="1"')) },
  cafe: { name: 'Café', svg: svg(`<rect x="0" y="62" width="100" height="38" fill="#2a1a12"/><ellipse cx="50" cy="60" rx="30" ry="9" fill="#3b2418"/><path d="M22 58h56l-6 26a8 8 0 0 1-8 6H36a8 8 0 0 1-8-6Z" fill="#f2ebe3"/><ellipse cx="50" cy="58" rx="28" ry="6" fill="#6b3f22"/><path d="M44 57c3-3 9-3 12 0-3 2-9 2-12 0Z" fill="#d9b48c"/><path d="M78 64c9 0 9 12 0 12" stroke="#f2ebe3" stroke-width="4" fill="none"/><path d="M42 40c-4-6 4-8 0-14M52 40c-4-6 4-8 0-14" stroke="#fff" stroke-width="2" fill="none" opacity=".35"/>`, grad('g', '#6e4a35', '#3a261b')) },
  aurora: { name: 'Aurora', svg: svg(`${stars(25, 3)}<path d="M-5 55C20 20 45 70 70 30s30 20 40 5v30H-5Z" fill="#3df2b0" opacity=".45"/><path d="M-5 65C25 35 50 80 75 45s25 15 35 5v30H-5Z" fill="#5be3ff" opacity=".35"/><path d="M0 85 25 72l15 8 20-12 18 10 22-8v30H0Z" fill="#e8f3ff"/>`, grad('g', '#06122e', '#14406b')) },
  desierto: { name: 'Desierto', svg: svg(`<circle cx="72" cy="30" r="9" fill="#fff6d6" opacity=".9"/><path d="M0 70c25-14 45-14 70-2s30 4 30 4v28H0Z" fill="#e7a14f"/><path d="M0 82c30-12 50-6 70 2s30-4 30-4v20H0Z" fill="#c97a32"/>`, grad('g', '#3f8fe6', '#f6d9a0')) },
  atardecer: { name: 'Atardecer', svg: svg(`<circle cx="50" cy="62" r="20" fill="#ffd36b"/><path d="M0 70h100v30H0Z" fill="#3a1d48"/><path d="M0 74h100M10 80h80M22 86h56" stroke="#ff9a6b" stroke-width="2" opacity=".6"/><path d="M58 30l6 3 6-3M70 38l4 2 4-2" stroke="#2b1335" stroke-width="1.6" fill="none"/>`, grad('g', '#ff6b6b', '#ffb36b')) },
  turquesa: { name: 'Turquesa', svg: svg(`${stars(70, 11, '#7ff7e6')}${stars(40, 23, '#0b3d3a')}`, grad('g', '#0f6f6a', '#0b3b44', 'x1="0" y1="0" x2="1" y2="1"')) },
  montanas: { name: 'Montañas', svg: svg(`<ellipse cx="25" cy="30" rx="18" ry="6" fill="#fff" opacity=".85"/><ellipse cx="70" cy="22" rx="14" ry="5" fill="#fff" opacity=".7"/><path d="M0 72 22 48l16 14 18-24 22 22 22-16v56H0Z" fill="#2d5b6e"/><path d="M0 84l26-16 18 10 20-14 18 12 18-8v32H0Z" fill="#173a48"/>`, grad('g', '#9fd4ea', '#e9f6fb')) },
  oceano: { name: 'Océano', svg: svg(`<path d="M0 55c10-6 20-6 30 0s20 6 30 0 20-6 30 0 10 6 10 6v40H0Z" fill="#2b8fd6"/><path d="M0 70c10-6 20-6 30 0s20 6 30 0 20-6 30 0 10 6 10 6v30H0Z" fill="#1a6db3"/><path d="M0 85c10-6 20-6 30 0s20 6 30 0 20-6 30 0 10 6 10 6v20H0Z" fill="#114e86"/>`, grad('g', '#bfe9ff', '#6cc4f5')) },
  bosque: { name: 'Bosque', svg: svg(`<path d="M10 90 22 52l12 38ZM30 92l14-48 14 48ZM55 92l12-40 12 40ZM75 90l11-34 11 34Z" fill="#1f5a3a"/><path d="M0 88h100v12H0Z" fill="#163f29"/><path d="M42 94 52 60l10 34Z" fill="#2e7a4f"/>`, grad('g', '#cfeccf', '#7fbf8f')) },
  noche: { name: 'Noche', svg: svg(`${stars(40, 5)}<circle cx="70" cy="30" r="12" fill="#f4f1d0"/><circle cx="75" cy="26" r="11" fill="#13183a"/><path d="M0 80 20 70l20 8 20-10 20 8 20-6v30H0Z" fill="#0a0d22"/>`, grad('g', '#13183a', '#2c3470')) },
  coral: { name: 'Coral', svg: svg(`<circle cx="20" cy="25" r="22" fill="#fff" opacity=".12"/><circle cx="85" cy="80" r="30" fill="#fff" opacity=".1"/>`, grad('g', '#ff7a8a', '#ffb199', 'x1="0" y1="0" x2="1" y2="1"')) },
  lavanda: { name: 'Lavanda', svg: svg(`<circle cx="80" cy="20" r="25" fill="#fff" opacity=".12"/><circle cx="15" cy="85" r="28" fill="#fff" opacity=".1"/>`, grad('g', '#7b6cf6', '#c49bf5', 'x1="0" y1="0" x2="1" y2="1"')) },
  grafito: { name: 'Grafito', svg: svg(`<path d="M0 100 100 0" stroke="#fff" stroke-width="18" opacity=".05"/>`, grad('g', '#3a3f47', '#1c1f24', 'x1="0" y1="0" x2="1" y2="1"')) },
  limon: { name: 'Limón', svg: svg(`<circle cx="75" cy="30" r="22" fill="#fff" opacity=".18"/>`, grad('g', '#c6e85a', '#5fbf5a', 'x1="0" y1="0" x2="1" y2="1"')) },
  naranja: { name: 'Naranja', svg: svg(`<circle cx="25" cy="70" r="26" fill="#fff" opacity=".14"/>`, grad('g', '#ffb347', '#ff7043', 'x1="0" y1="0" x2="1" y2="1"')) },
  cielo: { name: 'Cielo', svg: svg(`<ellipse cx="30" cy="60" rx="22" ry="8" fill="#fff" opacity=".9"/><ellipse cx="70" cy="38" rx="18" ry="6" fill="#fff" opacity=".8"/>`, grad('g', '#5aa9ff', '#bfe0ff')) },
};

// Portadas predeterminadas de UpNote → la más parecida de las propias (al importar).
export const UPNOTE_COVER_MAP = {
  cover24: 'galaxia', cover29: 'cafe', cover17: 'aurora', cover18: 'desierto',
  cover45: 'atardecer', cover10: 'turquesa', cover37: 'montanas',
};

const urlCache = new Map();
export function presetURL(key) {
  const p = PRESETS[key];
  if (!p) return null;
  if (!urlCache.has(key)) urlCache.set(key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.svg)}`);
  return urlCache.get(key);
}

// Recorta al centro en cuadrado y achica (portada liviana).
export async function squareImage(file, size = 320) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  bmp.close?.();
  return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.86));
}
