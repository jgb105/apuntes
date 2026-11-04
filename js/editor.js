// Utilidades del editor: limpieza de HTML, comandos de formato e imágenes.

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'OBJECT', 'EMBED', 'FORM', 'INPUT',
  'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FRAME', 'FRAMESET']);
const SAFE_URL = /^(https?:|mailto:|tel:|#|blob:|data:image\/(png|jpe?g|gif|webp);)/i;

// Limpia HTML de origen externo (respaldos, pegado): quita scripts, eventos y URLs peligrosas.
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (DROP_TAGS.has(el.tagName)) { el.remove(); continue; }
      if (el.tagName === 'IFRAME') {
        const src = el.getAttribute('data-upnote-iframe-src') || el.getAttribute('src') || '';
        if (/^https?:/i.test(src)) {
          const a = doc.createElement('a');
          a.href = src; a.textContent = src;
          el.replaceWith(a);
        } else el.remove();
        continue;
      }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        const v = attr.value.trim();
        if (n.startsWith('on') || n === 'contenteditable' || n === 'srcset') el.removeAttribute(attr.name);
        else if ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action') && v && !SAFE_URL.test(v)) el.removeAttribute(attr.name);
        else if (n === 'style' && /expression|url\s*\(|javascript:/i.test(v)) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// HTML a guardar: sin las URL temporales (blob:) de los adjuntos propios.
export function serialize(editor) {
  const clone = editor.cloneNode(true);
  for (const img of clone.querySelectorAll('img[data-file]')) img.removeAttribute('src');
  for (const a of clone.querySelectorAll('a[data-file]')) a.setAttribute('href', '#');
  return clone.innerHTML;
}

export function closestIn(node, selector, root) {
  let el = node && (node.nodeType === 1 ? node : node.parentElement);
  while (el && el !== root) {
    if (el.matches(selector)) return el;
    el = el.parentElement;
  }
  return null;
}

function selectionNode() {
  const sel = window.getSelection();
  return sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
}

// Chrome a veces deja el cursor al inicio de la línea tras crear una lista: se restaura
// usando la posición en caracteres dentro del editor (los nodos de texto pueden recrearse).
function keepCaret(editor, fn) {
  const sel = window.getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let pos = null;
  if (r && r.collapsed && editor.contains(r.startContainer)) {
    const pre = document.createRange();
    pre.selectNodeContents(editor);
    pre.setEnd(r.startContainer, r.startOffset);
    pos = pre.toString().length;
  }
  fn();
  if (pos === null) return;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let left = pos, t;
  while ((t = walker.nextNode())) {
    if (left <= t.length) {
      const nr = document.createRange();
      nr.setStart(t, left);
      nr.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nr);
      return;
    }
    left -= t.length;
  }
}

export function runCommand(cmd, editor) {
  editor.focus();
  const node = selectionNode();
  if (cmd === 'checklist') { keepCaret(editor, () => toggleChecklist(editor)); return null; }
  if (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList') {
    keepCaret(editor, () => document.execCommand(cmd, false, null));
    return null;
  }
  switch (cmd) {
    case 'h1': case 'h2': case 'p': case 'blockquote': case 'pre': {
      const current = closestIn(node, 'h1,h2,blockquote,pre', editor);
      const target = current && current.tagName.toLowerCase() === cmd ? 'p' : cmd;
      document.execCommand('formatBlock', false, `<${target}>`);
      break;
    }
    case 'highlight': {
      const inMark = closestIn(node, 'mark', editor);
      if (inMark) {
        inMark.replaceWith(...inMark.childNodes);
      } else {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const mark = document.createElement('mark');
        try { range.surroundContents(mark); }
        catch { mark.appendChild(range.extractContents()); range.insertNode(mark); }
      }
      break;
    }
    case 'link': return 'link';
    case 'image': return 'image';
    default: document.execCommand(cmd, false, null);
  }
  return null;
}

function toggleChecklist(editor) {
  let li = closestIn(selectionNode(), 'li', editor);
  let ul = li?.parentElement;
  if (li && ul?.tagName === 'UL') {
    const isChecklist = li.hasAttribute('data-checked');
    for (const item of ul.children) {
      if (isChecklist) item.removeAttribute('data-checked');
      else if (!item.hasAttribute('data-checked')) item.setAttribute('data-checked', 'false');
    }
    return;
  }
  if (li && ul?.tagName === 'OL') document.execCommand('insertOrderedList'); // sale de la numerada
  document.execCommand('insertUnorderedList');
  li = closestIn(selectionNode(), 'li', editor);
  ul = li?.parentElement;
  if (ul) for (const item of ul.children) item.setAttribute('data-checked', 'false');
}

// Clic en la casilla de una tarea → marcar/desmarcar. Devuelve true si cambió algo.
export function handleChecklistClick(e, editor) {
  const li = closestIn(e.target, 'li[data-checked]', editor);
  if (!li) return false;
  const rect = li.getBoundingClientRect();
  const fontSize = parseFloat(getComputedStyle(li).fontSize) || 16;
  if (e.clientX - rect.left > fontSize * 1.6) return false;
  e.preventDefault();
  li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
  return true;
}

// Tras Enter dentro de una tarea marcada, la nueva tarea queda sin marcar.
export function fixNewChecklistItem(editor) {
  const li = closestIn(selectionNode(), 'li[data-checked]', editor);
  if (li && li.getAttribute('data-checked') === 'true' && !li.textContent.trim()) {
    li.setAttribute('data-checked', 'false');
  }
}

// Reduce fotos grandes (las del celular pesan varios MB) antes de guardarlas.
export async function compressImage(file, maxSide = 1800, quality = 0.85) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || file.size < 350_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(r => canvas.toBlob(r, type, quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, type === 'image/png' ? '.png' : '.jpg'), { type });
  } catch {
    return file;
  }
}

// Conversión simple a Markdown para exportar una nota.
export function toMarkdown(root) {
  const out = [];
  const inline = (node) => {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.nodeValue.replace(/\s+/g, ' '); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      const inner = inline(c);
      if (t === 'B' || t === 'STRONG') s += inner.trim() ? `**${inner}**` : inner;
      else if (t === 'I' || t === 'EM') s += inner.trim() ? `*${inner}*` : inner;
      else if (t === 'S' || t === 'STRIKE' || t === 'DEL') s += `~~${inner}~~`;
      else if (t === 'CODE') s += `\`${c.textContent}\``;
      else if (t === 'A') s += `[${inner}](${c.getAttribute('href') || ''})`;
      else if (t === 'BR') s += '  \n';
      else if (t === 'IMG') s += `![](${c.getAttribute('src') || ''})`;
      else s += inner;
    }
    return s;
  };
  const block = (node, depth = 0) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (c.nodeValue.trim()) out.push(c.nodeValue.trim(), ''); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (/^H[1-6]$/.test(t)) out.push(`${'#'.repeat(+t[1])} ${inline(c).trim()}`, '');
      else if (t === 'UL' || t === 'OL') {
        let n = 1;
        for (const li of c.children) {
          if (li.tagName !== 'LI') continue;
          const pad = '  '.repeat(depth);
          const checked = li.getAttribute('data-checked');
          const bullet = t === 'OL' ? `${n++}.` : checked ? `- [${checked === 'true' ? 'x' : ' '}]` : '-';
          const own = [...li.childNodes].filter(x => !(x.nodeType === 1 && /^(UL|OL)$/.test(x.tagName)));
          const tmp = document.createElement('div'); own.forEach(x => tmp.appendChild(x.cloneNode(true)));
          out.push(`${pad}${bullet} ${inline(tmp).trim()}`);
          for (const sub of li.children) if (/^(UL|OL)$/.test(sub.tagName)) block({ childNodes: [sub] }, depth + 1);
        }
        if (!depth) out.push('');
      } else if (t === 'BLOCKQUOTE') out.push(...inline(c).trim().split('\n').map(l => `> ${l}`), '');
      else if (t === 'PRE') out.push('```', c.textContent.replace(/\n$/, ''), '```', '');
      else if (t === 'HR') out.push('---', '');
      else if (c.querySelector('p,div,h1,h2,h3,ul,ol,pre,blockquote')) block(c, depth);
      else { const s = inline(c).trim(); out.push(s, ''); }
    }
  };
  block(root);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
