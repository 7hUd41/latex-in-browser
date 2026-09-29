// PDF preview: renders every page into canvases, fit to the panel width.
// A new version is rendered off-screen first, then swapped in one go,
// so the view never flickers and keeps its scroll position.
// Also: PDF coordinates for SyncTeX (points, origin top-left) both ways.

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

export class PdfView {
  constructor(container, { onSyncClick, onLayout, mode = 'page' } = {}) {
    this.onLayout = onLayout;
    this.aspect = null; // width / height of the first page
    this.container = container; // the scrolling element
    this.pages = document.createElement('div');
    this.pages.className = 'pdf-pages';
    this.container.appendChild(this.pages);
    this.data = null;
    this.mode = mode; // 'page': whole page visible, 'width': page as wide as the panel
    this.zoom = 1; // multiplies the fit
    this.renderId = 0;
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.rerender(), 150); })
      .observe(this.container);

    // double-click (or Cmd/Ctrl-click) on the PDF: jump to the source
    const handler = (e) => {
      const pos = this.positionAt(e);
      if (pos && onSyncClick) onSyncClick(pos);
    };
    this.container.addEventListener('dblclick', handler);

    // Pinch to zoom the preview only (not the whole page): trackpad pinch arrives
    // as ctrl+wheel (Chrome, Firefox) or as gesture events (Safari). The pages
    // are scaled right away with CSS, and re-rendered sharp when the pinch stops.
    this.container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.pinch(Math.exp(-e.deltaY * 0.01), e);
    }, { passive: false });
    let lastScale = 1;
    this.container.addEventListener('gesturestart', (e) => { e.preventDefault(); lastScale = 1; });
    this.container.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      this.pinch(e.scale / lastScale, e);
      lastScale = e.scale;
    });
    this.container.addEventListener('gestureend', (e) => e.preventDefault());
    this.container.addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey) handler(e); });
  }

  async load(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`PDF: ${res.status}`);
    this.data = new Uint8Array(await res.arrayBuffer());
    await this.rerender();
  }

  clear() {
    this.data = null;
    this.renderId++;
    this.pages.textContent = '';
  }

  setMode(mode) {
    this.mode = mode;
    this.zoom = 1;
    this.rerender();
  }

  pinch(factor, e) {
    if (!this.data) return;
    if (!this.pinching) this.pinching = { start: this.zoom, target: this.zoom, x: e.clientX, y: e.clientY };
    const p = this.pinching;
    p.target = Math.min(4, Math.max(0.25, p.target * factor));
    const rect = this.container.getBoundingClientRect();
    const ox = p.x - rect.left + this.container.scrollLeft;
    const oy = p.y - rect.top + this.container.scrollTop;
    this.pages.style.transformOrigin = `${ox}px ${oy}px`;
    this.pages.style.transform = `scale(${p.target / p.start})`;
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => this.endPinch(), 200);
  }

  endPinch() {
    const p = this.pinching;
    this.pinching = null;
    if (!p) return;
    const k = p.target / p.start;
    const rect = this.container.getBoundingClientRect();
    const px = p.x - rect.left;
    const py = p.y - rect.top;
    // keep the point under the fingers in place after the sharp re-render
    this.nextScroll = {
      left: (this.container.scrollLeft + px) * k - px,
      top: (this.container.scrollTop + py) * k - py,
    };
    this.zoom = p.target;
    this.rerender();
  }

  setZoom(z) {
    this.zoom = Math.min(4, Math.max(0.25, z));
    this.rerender();
  }

  async rerender() {
    if (!this.data) return;
    const id = ++this.renderId;
    // pdf.js takes ownership of the buffer: give it a copy
    const task = getDocument({ data: this.data.slice() });
    const pdf = await task.promise;
    try {
      const width = this.container.clientWidth; // the page fills the panel
      const height = this.container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      const aspect = first.width / first.height;
      if (aspect !== this.aspect) { this.aspect = aspect; if (this.onLayout) this.onLayout(); }
      const fit = this.mode === 'page'
        ? Math.min(width / first.width, height / first.height)
        : width / first.width;
      const fragment = document.createElement('div');
      fragment.className = 'pdf-pages';
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 }); // 1 unit = 1 PDF point
        const scale = fit * this.zoom; // CSS px per point
        const viewport = page.getViewport({ scale: scale * dpr });
        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.dataset.page = n;
        wrap.dataset.scale = scale;
        wrap.style.width = `${Math.floor(base.width * scale)}px`;
        wrap.style.height = `${Math.floor(base.height * scale)}px`;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, viewport }).promise;
        if (id !== this.renderId) return; // a newer render started: drop this one
        wrap.appendChild(canvas);
        fragment.appendChild(wrap);
      }
      if (this.pinching) return; // a pinch started meanwhile: its end re-renders
      const next = this.nextScroll;
      this.nextScroll = null;
      const scrollTop = next ? next.top : this.container.scrollTop;
      const scrollLeft = next ? next.left : this.container.scrollLeft;
      this.container.replaceChild(fragment, this.pages);
      this.pages = fragment;
      this.container.scrollTop = scrollTop;
      this.container.scrollLeft = scrollLeft;
      // a sync highlight still on screen survives the re-render
      if (this.marks && Date.now() < this.marks.until) this.drawMarks(this.marks.boxes, this.marks.until - Date.now());
    } finally {
      task.destroy();
    }
  }

  // Mouse event -> { page, x, y } in PDF points from the top-left corner.
  positionAt(e) {
    const wrap = e.target.closest('.pdf-page');
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const scale = Number(wrap.dataset.scale);
    return {
      page: Number(wrap.dataset.page),
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  // Scrolls to and briefly highlights SyncTeX boxes (points; h,v = left, baseline).
  showBoxes(boxes) {
    if (!boxes.length) return false;
    const top = this.drawMarks(boxes, 1600);
    if (top === null) return false;
    this.marks = { boxes, until: Date.now() + 1600 };
    const target = top - this.container.clientHeight / 3;
    this.container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    return true;
  }

  // Draws the marks; returns the top of the first one (in scroll coordinates) or null.
  drawMarks(boxes, duration) {
    const page = boxes[0].page;
    const wrap = this.pages.querySelector(`.pdf-page[data-page="${page}"]`);
    if (!wrap) return null;
    const scale = Number(wrap.dataset.scale);
    let top = Infinity;
    for (const old of this.pages.querySelectorAll('.sync-mark')) old.remove();
    for (const b of boxes.filter((x) => x.page === page)) {
      const mark = document.createElement('div');
      mark.className = 'sync-mark';
      mark.style.animationDuration = `${duration}ms`;
      const h = Math.max(b.H, 8);
      mark.style.left = `${b.h * scale - 2}px`;
      mark.style.top = `${(b.v - h) * scale - 2}px`;
      mark.style.width = `${Math.max(b.W, 8) * scale + 4}px`;
      mark.style.height = `${h * scale + 4}px`;
      wrap.appendChild(mark);
      top = Math.min(top, (b.v - h) * scale);
      setTimeout(() => mark.remove(), duration);
    }
    return wrap.offsetTop + top;
  }
}
