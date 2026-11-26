jQuery(document).ready(function ($) {
  function roundDec(val, precision = 1) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    const factor = Math.pow(10, precision);
    return Math.round(num * factor) / factor;
  }

  function parseDec(val, fallback = 0) {
    if (val === '' || val === null || val === undefined) return fallback;
    const num = parseFloat(String(val).trim().replace(',', '.'));
    return Number.isFinite(num) ? num : fallback;
  }

  // 1. Direct Browser Upload ke ImageKit.io (bebas batas 4.5 MB Vercel!)
  let activeUploadMeta = null;
  const fileInput = document.getElementById('ik-direct-file-input');

  $('.pb-ik-upload-btn').on('click', function () {
    activeUploadMeta = {
      btn: $(this),
      container: $(this).closest('.visual-editor-container'),
      targetInput: $('#' + $(this).data('target')),
      folder: $(this).data('folder') || '/photobooth/frames',
      isDigital: $(this).hasClass('is-digital'),
    };
    fileInput.value = '';
    fileInput.click();
  });

  if (fileInput) {
    fileInput.addEventListener('change', async function () {
      const file = this.files[0];
      if (!file || !activeUploadMeta) return;

      const { btn, container, targetInput, folder, isDigital } = activeUploadMeta;
      const origText = btn.text();
      btn.text('Mengunggah...').prop('disabled', true);

      try {
        const authRes = await fetch('/admin/api/imagekit-auth');
        const authJson = await authRes.json();
        if (!authJson.success) throw new Error(authJson.message || 'Gagal autentikasi ImageKit');

        const auth = authJson.data;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('fileName', file.name);
        fd.append('publicKey', auth.publicKey);
        fd.append('signature', auth.signature);
        fd.append('expire', String(auth.expire));
        fd.append('token', auth.token);
        fd.append('folder', folder);
        fd.append('useUniqueFileName', 'true');

        const upRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
          method: 'POST',
          body: fd,
        });
        const upJson = await upRes.json();
        if (!upRes.ok || !upJson.url) {
          throw new Error(upJson.message || 'Upload ImageKit gagal');
        }

        targetInput.val(upJson.url).trigger('change');
        if (!isDigital) {
          const imgEl = container.find('.ve-img');
          imgEl.attr('src', upJson.url);
          imgEl.one('load', () => updateVisualEditor(container));
        }
        btn.text('Berhasil!');
      } catch (err) {
        alert('Upload gagal: ' + err.message);
        btn.text('Gagal');
      } finally {
        setTimeout(() => btn.text(origText).prop('disabled', false), 1500);
      }
    });
  }

  // 2. Toggle Visual Opacity Aktif/Nonaktif & Sinkron URL Input Manual
  $('.frame-active-cb')
    .on('change', function () {
      if ($(this).is(':checked')) {
        $(this).closest('.visual-editor-container').css({ opacity: '1', filter: 'grayscale(0%)' });
      } else {
        $(this).closest('.visual-editor-container').css({ opacity: '0.5', filter: 'grayscale(100%)' });
      }
    })
    .trigger('change');

  $('.frame-url-input').on('change blur', function () {
    const container = $(this).closest('.visual-editor-container');
    const val = ($(this).val() || '').trim();
    const imgEl = container.find('.ve-img');
    if (val) {
      imgEl.attr('src', val);
      imgEl.one('load', () => updateVisualEditor(container));
    } else {
      imgEl.removeAttr('src');
    }
    updateVisualEditor(container);
  });

  // 3. Reset Frame
  $('.visual-editor-container').on('click', '.btn-reset-frame', function () {
    if (!confirm('Yakin kosongkan gambar dan reset seluruh koordinat frame ini menjadi 0?')) return;
    const container = $(this).closest('.visual-editor-container');
    container.find('input[type="text"]').val('');
    container.find('.ve-img').removeAttr('src');
    container.find('.frame-url-input').trigger('change');
    container.find('.frame-active-cb').prop('checked', false).trigger('change');
    const isNews = String(container.data('prefix') || '').startsWith('news');
    container.find('.canvas-w').val(1200);
    container.find('.canvas-h').val(isNews ? 1600 : 1800);
    container.find('input[class^="pose-"]').val(0);
    updateVisualEditor(container);
  });

  // 4. Render & Sync Kotak Koordinat (Mendukung Nilai Desimal)
  function updateVisualEditor(container) {
    const canvasW = parseDec(container.find('.canvas-w').val(), 1200) || 1200;
    const canvasH = parseDec(container.find('.canvas-h').val(), 1800) || 1800;
    const previewArea = container.find('.ve-canvas');
    const previewImg = container.find('.ve-img');

    if (!previewImg.attr('src')) {
      previewArea.css('aspect-ratio', canvasW + '/' + canvasH);
    } else {
      previewArea.css('aspect-ratio', 'auto');
    }

    const scale = previewArea.width() / canvasW;
    if (!scale || !Number.isFinite(scale)) return;

    container.find('.ve-box').each(function () {
      const pose = $(this).data('pose');
      const w = parseDec(container.find('.pose-w-' + pose).val(), 0);
      const h = parseDec(container.find('.pose-h-' + pose).val(), 0);
      const x = parseDec(container.find('.pose-x-' + pose).val(), 0);
      const y = parseDec(container.find('.pose-y-' + pose).val(), 0);
      if (w > 0 && h > 0) {
        $(this).css({ display: 'flex', width: w * scale, height: h * scale, left: x * scale, top: y * scale });
      } else {
        $(this).hide();
      }
    });
  }

  function showGuideX(g, t) { g.css({ top: t + 'px' }).show(); }
  function showGuideY(g, l) { g.css({ left: l + 'px' }).show(); }

  // 5. Draggable dengan Snap Alignment (Output Koordinat Desimal 0.1px)
  $('.ve-box').draggable({
    containment: 'parent',
    start: function () { $(this).focus(); },
    drag: function (event, ui) {
      const container = $(this).closest('.visual-editor-container');
      const canvas = container.find('.ve-canvas');
      const pose = $(this).data('pose');
      const canvasW = parseDec(container.find('.canvas-w').val(), 1200) || 1200;
      const scale = canvas.width() / canvasW;
      if (!scale || !Number.isFinite(scale)) return;

      const guideX = container.find('.guide-x').hide();
      const guideY = container.find('.guide-y').hide();
      const snapDist = 6;

      const cl = ui.position.left, ct = ui.position.top, cw = $(this).outerWidth(), ch = $(this).outerHeight();
      const cr = cl + cw, cb = ct + ch, ccx = cl + cw / 2, ccy = ct + ch / 2;
      let snappedX = false, snappedY = false;

      container.find('.ve-box:visible').not(this).each(function () {
        const op = $(this).position(), ow = $(this).outerWidth(), oh = $(this).outerHeight();
        const ol = op.left, ot = op.top, or = ol + ow, obb = ot + oh, ocx = ol + ow / 2, ocy = ot + oh / 2;

        if (!snappedX) {
          if (Math.abs(cl - ol) < snapDist) { ui.position.left = ol; snappedX = true; showGuideY(guideY, ol); }
          else if (Math.abs(cl - or) < snapDist) { ui.position.left = or; snappedX = true; showGuideY(guideY, or); }
          else if (Math.abs(cr - or) < snapDist) { ui.position.left = or - cw; snappedX = true; showGuideY(guideY, or); }
          else if (Math.abs(cr - ol) < snapDist) { ui.position.left = ol - cw; snappedX = true; showGuideY(guideY, ol); }
          else if (Math.abs(ccx - ocx) < snapDist) { ui.position.left = ocx - cw / 2; snappedX = true; showGuideY(guideY, ocx); }
        }
        if (!snappedY) {
          if (Math.abs(ct - ot) < snapDist) { ui.position.top = ot; snappedY = true; showGuideX(guideX, ot); }
          else if (Math.abs(ct - obb) < snapDist) { ui.position.top = obb; snappedY = true; showGuideX(guideX, obb); }
          else if (Math.abs(cb - obb) < snapDist) { ui.position.top = obb - ch; snappedY = true; showGuideX(guideX, obb); }
          else if (Math.abs(cb - ot) < snapDist) { ui.position.top = ot - ch; snappedY = true; showGuideX(guideX, ot); }
          else if (Math.abs(ccy - ocy) < snapDist) { ui.position.top = ocy - ch / 2; snappedY = true; showGuideX(guideX, ocy); }
        }
      });

      container.find('.pose-x-' + pose).val(roundDec(ui.position.left / scale, 1));
      container.find('.pose-y-' + pose).val(roundDec(ui.position.top / scale, 1));
    },
    stop: function () {
      $(this).closest('.visual-editor-container').find('.guide-x, .guide-y').hide();
    },
  });

  // 6. Duplikat, Hapus, & Keyboard Arrows (Shift = 10px, Alt = 0.1px, Normal = 1px)
  function duplicateBox(container, pose) {
    const maxPoses = String(container.data('prefix') || '').startsWith('news') ? 2 : 6;
    let emptyPose = null;
    for (let p = 1; p <= maxPoses; p++) {
      if (parseDec(container.find('.pose-w-' + p).val(), 0) === 0) { emptyPose = p; break; }
    }
    if (!emptyPose) return alert('Kapasitas kotak penuh! Hapus salah satu kotak dulu.');

    container.find('.pose-w-' + emptyPose).val(roundDec(parseDec(container.find('.pose-w-' + pose).val(), 0), 2));
    container.find('.pose-h-' + emptyPose).val(roundDec(parseDec(container.find('.pose-h-' + pose).val(), 0), 2));
    container.find('.pose-x-' + emptyPose).val(roundDec(parseDec(container.find('.pose-x-' + pose).val(), 0) + 20, 2));
    container.find('.pose-y-' + emptyPose).val(roundDec(parseDec(container.find('.pose-y-' + pose).val(), 0) + 20, 2));
    updateVisualEditor(container);
    container.find('.ve-box-p' + emptyPose).focus();
  }

  $('.ve-box').on('keydown', function (e) {
    const container = $(this).closest('.visual-editor-container');
    const pose = $(this).data('pose');
    const inputX = container.find('.pose-x-' + pose);
    const inputY = container.find('.pose-y-' + pose);
    let x = parseDec(inputX.val(), 0);
    let y = parseDec(inputY.val(), 0);
    const step = e.shiftKey ? 10 : (e.altKey ? 0.1 : 1);
    let changed = false;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      container.find('.pose-w-' + pose).val(0);
      container.find('.pose-h-' + pose).val(0);
      updateVisualEditor(container);
      e.preventDefault();
      return;
    }
    if (e.key === 'd' || e.key === 'D') {
      duplicateBox(container, pose);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') { y = roundDec(y - step, 2); changed = true; }
    else if (e.key === 'ArrowDown') { y = roundDec(y + step, 2); changed = true; }
    else if (e.key === 'ArrowLeft') { x = roundDec(x - step, 2); changed = true; }
    else if (e.key === 'ArrowRight') { x = roundDec(x + step, 2); changed = true; }

    if (changed) {
      e.preventDefault();
      inputX.val(x);
      inputY.val(y);
      updateVisualEditor(container);
    }
  });

  $('.visual-editor-container').on('click', '.box-dup', function (e) {
    e.stopPropagation();
    duplicateBox($(this).closest('.visual-editor-container'), $(this).closest('.ve-box').data('pose'));
  });
  $('.visual-editor-container').on('click', '.box-del', function (e) {
    e.stopPropagation();
    const c = $(this).closest('.visual-editor-container');
    const p = $(this).closest('.ve-box').data('pose');
    c.find('.pose-w-' + p).val(0);
    c.find('.pose-h-' + p).val(0);
    updateVisualEditor(c);
  });

  // 7. Drag-to-Draw di Kanvas Kosong (Mendukung Output Desimal)
  let drawState = { isDrawing: false, startX: 0, startY: 0, pose: null, container: null, canvas: null, scale: 1 };
  $('.ve-canvas').on('mousedown', function (e) {
    if ($(e.target).closest('.ve-box').length) return;
    const container = $(this).closest('.visual-editor-container');
    const maxPoses = String(container.data('prefix') || '').startsWith('news') ? 2 : 6;
    let poseToDraw = null;
    for (let p = 1; p <= maxPoses; p++) {
      if (parseDec(container.find('.pose-w-' + p).val(), 0) === 0) { poseToDraw = p; break; }
    }
    if (!poseToDraw) return alert('Kapasitas kotak penuh!');
    const canvas = $(this), offset = canvas.offset();
    const canvasW = parseDec(container.find('.canvas-w').val(), 1200) || 1200;
    const scale = canvas.width() / canvasW;
    if (!scale || !Number.isFinite(scale)) return;

    drawState = { isDrawing: true, startX: e.pageX - offset.left, startY: e.pageY - offset.top, pose: poseToDraw, container, canvas, scale };
    container.find('.ve-box-p' + poseToDraw).css({ display: 'flex', left: drawState.startX, top: drawState.startY, width: 0, height: 0 });
    e.preventDefault();
  });

  $(document).on('mousemove', function (e) {
    if (!drawState.isDrawing) return;
    const offset = drawState.canvas.offset();
    const curX = e.pageX - offset.left, curY = e.pageY - offset.top;
    drawState.container.find('.ve-box-p' + drawState.pose).css({
      left: Math.min(drawState.startX, curX),
      top: Math.min(drawState.startY, curY),
      width: Math.abs(curX - drawState.startX),
      height: Math.abs(curY - drawState.startY),
    });
  });

  $(document).on('mouseup', function () {
    if (!drawState.isDrawing) return;
    const box = drawState.container.find('.ve-box-p' + drawState.pose);
    const left = parseFloat(box.css('left')) || 0;
    const top = parseFloat(box.css('top')) || 0;
    const width = parseFloat(box.css('width')) || 0;
    const height = parseFloat(box.css('height')) || 0;
    if (width < 15 || height < 15) {
      box.hide();
    } else {
      drawState.container.find('.pose-x-' + drawState.pose).val(roundDec(left / drawState.scale, 1));
      drawState.container.find('.pose-y-' + drawState.pose).val(roundDec(top / drawState.scale, 1));
      drawState.container.find('.pose-w-' + drawState.pose).val(roundDec(width / drawState.scale, 1));
      drawState.container.find('.pose-h-' + drawState.pose).val(roundDec(height / drawState.scale, 1));
      box.focus();
    }
    drawState.isDrawing = false;
    drawState.pose = null;
  });

  // 8. Zoom, Sesuaikan Dimensi & Auto-Detect Lubang Transparan
  function applyZoom(container, newZoom) {
    newZoom = Math.max(50, Math.min(300, newZoom));
    container.find('.ve-canvas').attr('data-zoom', newZoom).css('width', newZoom + '%');
    container.find('.zoom-level').text(newZoom + '%');
    updateVisualEditor(container);
  }
  $('.btn-zoom-in').click(function () { const c = $(this).closest('.visual-editor-container'); applyZoom(c, (parseInt(c.find('.ve-canvas').attr('data-zoom'), 10) || 100) + 25); });
  $('.btn-zoom-out').click(function () { const c = $(this).closest('.visual-editor-container'); applyZoom(c, (parseInt(c.find('.ve-canvas').attr('data-zoom'), 10) || 100) - 25); });
  $('.btn-zoom-reset').click(function () { applyZoom($(this).closest('.visual-editor-container'), 100); });
  $('.visual-editor-container input[type="number"]').not('.frame-order-input').on('input change', function () {
    updateVisualEditor($(this).closest('.visual-editor-container'));
  });
  $(window).on('resize', () => $('.visual-editor-container').each(function () { updateVisualEditor($(this)); }));
  $('.visual-editor-container').each(function () { updateVisualEditor($(this)); });

  $('.visual-editor-container').on('click', '.btn-match-dim', function () {
    const btn = $(this), container = btn.closest('.visual-editor-container'), $img = container.find('.ve-img');
    const rawSrc = ($img.attr('src') || '').trim();
    if (!rawSrc) return alert('Harap pilih gambar frame terlebih dahulu!');
    const img = new Image();
    img.onload = function () {
      container.find('.canvas-w').val(this.width);
      container.find('.canvas-h').val(this.height);
      updateVisualEditor(container);
      const oldText = btn.text();
      btn.text('Disesuaikan!');
      setTimeout(() => btn.text(oldText), 1500);
    };
    img.src = rawSrc;
  });

  $('.visual-editor-container').on('click', '.btn-auto-detect', function () {
    const btn = $(this), container = btn.closest('.visual-editor-container'), $img = container.find('.ve-img'), originalText = btn.text();
    const rawSrc = ($img.attr('src') || '').trim();
    if (!rawSrc) return alert('Harap pilih/upload gambar frame terlebih dahulu!');
    btn.text('Loading...').prop('disabled', true);

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = function () {
      try {
        const canvas = document.createElement('canvas');
        // Bulatkan ke integer khusus untuk buffer piksel canvas agar Uint8Array tidak error jika dimensi desimal
        const w = Math.max(1, Math.round(parseDec(container.find('.canvas-w').val(), img.width) || img.width));
        const h = Math.max(1, Math.round(parseDec(container.find('.canvas-h').val(), img.height) || img.height));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        const imgData = ctx.getImageData(0, 0, w, h).data;
        const maxArea = w * h;
        const visited = new Uint8Array(maxArea);
        const isHole = new Uint8Array(maxArea);
        const boxes = [];
        const qX = new Uint32Array(maxArea);
        const qY = new Uint32Array(maxArea);

        for (let i = 0; i < maxArea; i++) {
          const r = imgData[i * 4], g = imgData[i * 4 + 1], b = imgData[i * 4 + 2], a = imgData[i * 4 + 3];
          if (a < 10 || (a > 200 && r > 245 && g > 245 && b > 245)) isHole[i] = 1;
        }
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (isHole[idx] === 1 && visited[idx] === 0) {
              let head = 0, tail = 0, minX = x, maxX = x, minY = y, maxY = y;
              qX[tail] = x; qY[tail] = y; tail++; visited[idx] = 1;
              while (head < tail) {
                const cx = qX[head], cy = qY[head]; head++;
                if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                let nIdx;
                if (cx + 1 < w) { nIdx = cy * w + (cx + 1); if (isHole[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; qX[tail] = cx + 1; qY[tail] = cy; tail++; } }
                if (cx - 1 >= 0) { nIdx = cy * w + (cx - 1); if (isHole[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; qX[tail] = cx - 1; qY[tail] = cy; tail++; } }
                if (cy + 1 < h) { nIdx = (cy + 1) * w + cx; if (isHole[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; qX[tail] = cx; qY[tail] = cy + 1; tail++; } }
                if (cy - 1 >= 0) { nIdx = (cy - 1) * w + cx; if (isHole[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; qX[tail] = cx; qY[tail] = cy - 1; tail++; } }
              }
              const boxW = maxX - minX + 1, boxH = maxY - minY + 1;
              if (boxW > 100 && boxH > 100) boxes.push({ x: minX, y: minY, w: boxW, h: boxH });
            }
          }
        }
        boxes.sort((a, b) => (Math.abs(a.y - b.y) < 50 ? a.x - b.x : a.y - b.y));
        const maxPoses = String(container.data('prefix') || '').startsWith('news') ? 2 : 6;
        for (let p = 1; p <= maxPoses; p++) { container.find('.pose-w-' + p).val(0); container.find('.pose-h-' + p).val(0); }
        let applied = 0;
        for (let i = 0; i < boxes.length && i < maxPoses; i++) {
          const p = i + 1;
          container.find('.pose-x-' + p).val(boxes[i].x);
          container.find('.pose-y-' + p).val(boxes[i].y);
          container.find('.pose-w-' + p).val(boxes[i].w);
          container.find('.pose-h-' + p).val(boxes[i].h);
          applied++;
        }
        updateVisualEditor(container);
        btn.text('Ditemukan ' + applied + ' Kotak');
      } catch (e) {
        alert('Gagal membaca piksel! Pastikan gambar PNG berasal dari ImageKit.io atau mendukung CORS.');
        btn.text('Error CORS');
      }
      setTimeout(() => btn.text(originalText).prop('disabled', false), 2500);
    };
    let src = rawSrc;
    if (src.indexOf('?') === -1) src += '?nocache=' + Date.now();
    img.src = src;
  });
});