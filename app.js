// Вся обработка файлов происходит здесь же, в браузере. Ни один байт содержимого
// загруженных файлов никуда не отправляется — только чтение через File API,
// работа с pdf.js/pdf-lib (локальные копии в vendor/) и локальное сохранение результата.

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const RENDER_SCALE = 2.5;
const BOX_PADDING_PX = 2;

const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const typeCheckboxes = Array.from(document.querySelectorAll(".type-check"));
const logEl = document.getElementById("log");
const resultsEl = document.getElementById("results");

function log(message) {
  const line = document.createElement("div");
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function enabledTypes() {
  const set = new Set();
  typeCheckboxes.forEach((cb) => {
    if (cb.checked) set.add(cb.value);
  });
  return set;
}

function itemRect(item) {
  const x0 = item.transform[4];
  const baseline = item.transform[5];
  const h = item.height || Math.hypot(item.transform[2], item.transform[3]) || 10;
  const w = item.width || 0;
  return {
    x0,
    y0: baseline - h * 0.25,
    x1: x0 + w,
    y1: baseline + h * 1.05,
  };
}

// Средняя ширина одного символа внутри текстового блока pdf.js. PDF-генераторы часто
// отдают целую строку или даже абзац одним блоком (item) — если закрашивать весь
// item целиком при любом совпадении внутри него, лишний текст вокруг найденных данных
// тоже пропадает. Поэтому для найденных символов считаем их приблизительное положение
// внутри блока (ширина блока, поделённая на число символов) и закрашиваем только его.
function itemCharWidth(item) {
  const w = item.width || 0;
  return item.str.length > 0 ? w / item.str.length : 0;
}

function unionRect(a, b) {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function buildLines(items) {
  // Группируем по Y-координате базовой линии, а не по item.hasEOL — этот флаг
  // pdf.js расставляет ненадёжно в зависимости от того, чем создан PDF, и может
  // склеить две визуально разные строки в одну, из-за чего чёрный блок захватывал
  // сразу несколько строк текста.
  const visible = items.filter((it) => it.str.length > 0);
  visible.forEach((it) => {
    it._rect = itemRect(it);
    it._charWidth = itemCharWidth(it);
  });
  const sorted = visible.slice().sort((a, b) => {
    const ay = (a._rect.y0 + a._rect.y1) / 2;
    const by = (b._rect.y0 + b._rect.y1) / 2;
    return by - ay; // сверху вниз страницы
  });

  const lines = [];
  let current = [];
  let currentY = null;
  const Y_TOL_RATIO = 0.4;
  for (const it of sorted) {
    const y = (it._rect.y0 + it._rect.y1) / 2;
    const h = it._rect.y1 - it._rect.y0;
    const tol = Math.max(h, 4) * Y_TOL_RATIO;
    if (currentY === null || Math.abs(y - currentY) <= tol) {
      current.push(it);
      if (currentY === null) currentY = y;
    } else {
      current.sort((a, b) => a._rect.x0 - b._rect.x0);
      lines.push(current);
      current = [it];
      currentY = y;
    }
  }
  if (current.length) {
    current.sort((a, b) => a._rect.x0 - b._rect.x0);
    lines.push(current);
  }
  return lines;
}

function buildLineString(lineItems) {
  let str = "";
  // Для каждого символа строки запоминаем, из какого item он взят и какой у него
  // порядковый номер ВНУТРИ этого item (null — вставленный пробел между items,
  // не принадлежит никакому item).
  const charMap = [];
  lineItems.forEach((it, idx) => {
    const rect = it._rect;
    if (idx > 0) {
      const prev = lineItems[idx - 1];
      const gap = rect.x0 - prev._rect.x1;
      const prevHeight = prev._rect.y1 - prev._rect.y0;
      if (gap > prevHeight * 0.15) {
        str += " ";
        charMap.push(null);
      }
    }
    for (let i = 0; i < it.str.length; i++) {
      str += it.str[i];
      charMap.push({ idx, local: i });
    }
  });
  return { str, charMap };
}

function collectRedactionRects(lineItems, activeTypes) {
  // itemRect/itemCharWidth для каждого элемента уже вычислены в buildLines().
  const { str, charMap } = buildLineString(lineItems);
  const matches = window.PDN_DETECT_LINE(str);
  const rects = [];
  for (const match of matches) {
    if (!activeTypes.has(match.type)) continue;
    log(`    найдено [${match.type}]: "${str.slice(match.start, match.end)}"`);
    // Для каждого затронутого item находим МИНИМАЛЬНЫЙ и МАКСИМАЛЬНЫЙ локальный
    // индекс символа, попавшего в совпадение, и закрашиваем только этот диапазон
    // внутри item, а не весь item целиком.
    const perItem = new Map();
    for (let c = match.start; c < match.end; c++) {
      const cm = charMap[c];
      if (!cm) continue;
      const cur = perItem.get(cm.idx);
      if (!cur) perItem.set(cm.idx, { min: cm.local, max: cm.local });
      else {
        if (cm.local < cur.min) cur.min = cm.local;
        if (cm.local > cur.max) cur.max = cm.local;
      }
    }
    if (perItem.size === 0) continue;
    let rect = null;
    for (const [idx, { min, max }] of perItem) {
      const item = lineItems[idx];
      const charW = item._charWidth;
      const partial = {
        x0: item._rect.x0 + charW * min,
        x1: item._rect.x0 + charW * (max + 1),
        y0: item._rect.y0,
        y1: item._rect.y1,
      };
      rect = rect ? unionRect(rect, partial) : partial;
    }
    rects.push(rect);
  }
  return rects;
}

// ---- Распознавание сканов (OCR) ----
//
// Если у страницы нет текстового слоя вообще (отсканированный/сфотографированный
// документ), pdf.js не находит ни одного символа — обычному пайплайну просто
// нечего анализировать. В этом случае страницу распознаём через Tesseract.js
// (работает целиком в браузере, языковая модель — локальный файл в vendor/,
// ничего никуда не отправляется). OCR сам даёт координаты каждого слова на
// картинке — они уже точные (реально измеренные), в отличие от оценки по весам
// символов для обычных текстовых PDF.

// Tesseract.js создаёт внутренний воркер через Blob-URL, а внутри такого воркера
// относительные пути не разрешаются относительно адреса страницы — нужны
// абсолютные URL, иначе importScripts падает с "invalid URL".
function absoluteUrl(path) {
  return new URL(path, window.location.href).href;
}

let ocrWorkerPromise = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("rus", 1, {
      workerPath: absoluteUrl("vendor/tesseract/worker.min.js"),
      corePath: absoluteUrl("vendor/tesseract/tesseract-core-simd-lstm.wasm.js"),
      langPath: absoluteUrl("vendor/tesseract/lang-data"),
    });
  }
  return ocrWorkerPromise;
}

async function terminateOcrWorker() {
  if (ocrWorkerPromise) {
    const worker = await ocrWorkerPromise;
    ocrWorkerPromise = null;
    await worker.terminate();
  }
}

function hasSelectableText(textContent) {
  return textContent.items.some((it) => it.str.trim().length > 0);
}

// Собирает ПЛОСКИЙ список всех распознанных слов, независимо от того, как
// Tesseract сгруппировал их во внутренние blocks/paragraphs/lines.
function extractAllOcrWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) words.push(w);
      }
    }
  }
  return words;
}

// Группируем слова OCR по Y-координате их bbox сами — так же, как buildLines()
// для обычных PDF — а НЕ полагаемся на встроенную группировку в "строки" самого
// Tesseract. Она иногда ошибочно объединяет две соседние визуальные строки в
// одну (тогда чёрный блок захватывает вместе с личными данными ещё и соседний
// нейтральный текст) или наоборот разбивает одну строку на части (тогда
// совпадение, требующее слова из обеих частей, не находится вовсе).
function groupOcrWordsIntoLines(words) {
  const valid = words.filter((w) => (w.text || "").trim().length > 0 && w.bbox);
  const withCenter = valid.map((w) => ({
    w,
    cy: (w.bbox.y0 + w.bbox.y1) / 2,
    h: w.bbox.y1 - w.bbox.y0,
  }));
  withCenter.sort((a, b) => a.cy - b.cy);

  const lines = [];
  let current = [];
  let currentY = null;
  const Y_TOL_RATIO = 0.5;
  for (const item of withCenter) {
    const tol = Math.max(item.h, 4) * Y_TOL_RATIO;
    if (currentY === null || Math.abs(item.cy - currentY) <= tol) {
      current.push(item.w);
      if (currentY === null) currentY = item.cy;
    } else {
      current.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      lines.push(current);
      current = [item.w];
      currentY = item.cy;
    }
  }
  if (current.length) {
    current.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    lines.push(current);
  }
  return lines;
}

// Строит строку текста и карту "символ -> слово" для одной распознанной строки,
// аналогично buildLineString() для обычных текстовых PDF, но на основе слов OCR.
function buildOcrLineString(words) {
  let str = "";
  const charMap = [];
  words.forEach((w, idx) => {
    if (idx > 0) {
      str += " ";
      charMap.push(null);
    }
    const text = w.text || "";
    for (let i = 0; i < text.length; i++) {
      str += text[i];
      charMap.push({ idx, local: i });
    }
  });
  return { str, charMap };
}

function ocrWordRect(word) {
  const b = word.bbox;
  return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

// Прямоугольник для диапазона символов [min, max] внутри одного слова OCR. Если
// затронуто слово целиком — используем его настоящий bbox без всякой оценки. Если
// только часть (например, цифры внутри "ИНН:12345" без пробела) — используем
// символьные bbox из OCR, если движок их вернул, а иначе равномерно делим bbox
// слова по числу символов (тот же запасной приём, что и для обычных PDF).
function ocrPartialRect(word, min, max) {
  const text = word.text || "";
  if (min === 0 && max === text.length - 1) return ocrWordRect(word);
  if (Array.isArray(word.symbols) && word.symbols.length === text.length) {
    let rect = null;
    for (let i = min; i <= max; i++) {
      const sRect = { x0: word.symbols[i].bbox.x0, y0: word.symbols[i].bbox.y0, x1: word.symbols[i].bbox.x1, y1: word.symbols[i].bbox.y1 };
      rect = rect ? unionRect(rect, sRect) : sRect;
    }
    return rect;
  }
  const full = ocrWordRect(word);
  const charW = text.length > 0 ? (full.x1 - full.x0) / text.length : 0;
  return { x0: full.x0 + charW * min, x1: full.x0 + charW * (max + 1), y0: full.y0, y1: full.y1 };
}

function collectOcrRedactionRects(data, activeTypes) {
  const rects = [];
  const lines = groupOcrWordsIntoLines(extractAllOcrWords(data));
  for (const words of lines) {
    if (words.length === 0) continue;
    const { str, charMap } = buildOcrLineString(words);
    const matches = window.PDN_DETECT_LINE(str);
    for (const match of matches) {
      if (!activeTypes.has(match.type)) continue;
      log(`    найдено [${match.type}]: "${str.slice(match.start, match.end)}"`);
      const perWord = new Map();
      for (let c = match.start; c < match.end; c++) {
        const cm = charMap[c];
        if (!cm) continue;
        const cur = perWord.get(cm.idx);
        if (!cur) perWord.set(cm.idx, { min: cm.local, max: cm.local });
        else {
          if (cm.local < cur.min) cur.min = cm.local;
          if (cm.local > cur.max) cur.max = cm.local;
        }
      }
      if (perWord.size === 0) continue;
      let rect = null;
      for (const [idx, { min, max }] of perWord) {
        const partial = ocrPartialRect(words[idx], min, max);
        rect = rect ? unionRect(rect, partial) : partial;
      }
      rects.push(rect);
    }
  }
  return rects;
}

async function redactPdf(file, activeTypes) {
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  const outDoc = await PDFLib.PDFDocument.create();

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    let redactionRects;
    if (hasSelectableText(textContent)) {
      const lines = buildLines(textContent.items);
      redactionRects = [];
      for (const lineItems of lines) {
        redactionRects.push(...collectRedactionRects(lineItems, activeTypes));
      }

      ctx.fillStyle = "#000000";
      for (const rect of redactionRects) {
        const vp = viewport.convertToViewportRectangle([rect.x0, rect.y0, rect.x1, rect.y1]);
        const x = Math.min(vp[0], vp[2]);
        const y = Math.min(vp[1], vp[3]);
        const w = Math.abs(vp[2] - vp[0]);
        const h = Math.abs(vp[3] - vp[1]);
        ctx.fillRect(x - BOX_PADDING_PX, y - BOX_PADDING_PX, w + BOX_PADDING_PX * 2, h + BOX_PADDING_PX * 2);
      }
    } else {
      // Текстового слоя нет вообще — похоже на скан/фото. Распознаём через OCR.
      log(`  стр. ${pageNum}/${pdf.numPages}: текст не найден, похоже на скан — распознаю через OCR (это медленнее)...`);
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      redactionRects = collectOcrRedactionRects(data, activeTypes);

      ctx.fillStyle = "#000000";
      for (const rect of redactionRects) {
        const x = Math.min(rect.x0, rect.x1);
        const y = Math.min(rect.y0, rect.y1);
        const w = Math.abs(rect.x1 - rect.x0);
        const h = Math.abs(rect.y1 - rect.y0);
        ctx.fillRect(x - BOX_PADDING_PX, y - BOX_PADDING_PX, w + BOX_PADDING_PX * 2, h + BOX_PADDING_PX * 2);
      }
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const pngImage = await outDoc.embedPng(pngBytes);

    const unscaled = page.getViewport({ scale: 1 });
    const outPage = outDoc.addPage([unscaled.width, unscaled.height]);
    outPage.drawImage(pngImage, { x: 0, y: 0, width: unscaled.width, height: unscaled.height });

    log(`  стр. ${pageNum}/${pdf.numPages}: закрашено фрагментов — ${redactionRects.length}`);
  }

  const outBytes = await outDoc.save();
  return new Blob([outBytes], { type: "application/pdf" });
}

function addResultLink(originalName, blob) {
  const url = URL.createObjectURL(blob);
  const name = originalName.replace(/\.pdf$/i, "") + "_redacted.pdf";
  const wrapper = document.createElement("div");
  wrapper.className = "result-item";
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.textContent = `Скачать: ${name}`;
  wrapper.appendChild(a);
  resultsEl.appendChild(wrapper);
}

processBtn.addEventListener("click", async () => {
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) {
    log("Выберите хотя бы один PDF-файл.");
    return;
  }
  const activeTypes = enabledTypes();
  processBtn.disabled = true;
  resultsEl.innerHTML = "";
  logEl.innerHTML = "";

  for (const file of files) {
    log(`Обработка: ${file.name}`);
    try {
      const blob = await redactPdf(file, activeTypes);
      addResultLink(file.name, blob);
      log(`Готово: ${file.name}`);
    } catch (err) {
      log(`Ошибка при обработке ${file.name}: ${err.message}`);
      console.error(err);
    }
  }

  await terminateOcrWorker();
  processBtn.disabled = false;
});
