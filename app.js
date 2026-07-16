// Вся обработка файлов происходит здесь же, в браузере. Ни один байт содержимого
// загруженных файлов никуда не отправляется — только чтение через File API,
// работа с pdf.js/pdf-lib (локальные копии в vendor/) и локальное сохранение результата.

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const RENDER_SCALE = 2.5;
const BOX_PADDING_PX = 3;

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

// pdf.js не даёт ширину каждого отдельного символа — только суммарную ширину всего
// текстового блока. Первая версия делила эту ширину поровну на все символы, но
// реальные буквы и цифры разной ширины (например, заглавная "Ш" ощутимо шире цифры
// "1"), поэтому граница закрашивания то не доходила до конца данных, то заезжала на
// предыдущее слово. Ниже — грубые весовые коэффициенты по типу символа: цифры уже
// среднего, заглавные буквы шире, пробелы/пунктуация уже всего. Веса нормируются так,
// чтобы их сумма точно равнялась реальной ширине блока — это не настоящие метрики
// шрифта, но гораздо ближе к реальности, чем равномерное деление.
function charWeight(ch) {
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[A-ZА-ЯЁ]/.test(ch)) return 1.15;
  if (/[a-zа-яё]/.test(ch)) return 0.85;
  return 0.5; // пробелы, пунктуация и всё остальное
}

// Возвращает массив длиной str.length+1: offsets[i] — расстояние от левого края
// блока до левой границы символа с индексом i (offsets[0] = 0, offsets[len] = вся
// ширина блока).
function computeCharOffsets(item) {
  const w = item.width || 0;
  const str = item.str;
  const n = str.length;
  const offsets = new Array(n + 1).fill(0);
  if (n === 0) return offsets;
  const weights = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = charWeight(str[i]);
    total += weights[i];
  }
  const scale = total > 0 ? w / total : 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i] * scale;
    offsets[i + 1] = acc;
  }
  return offsets;
}

// Оценка по весам символов (computeCharOffsets) — только приблизительная стартовая
// точка. Дальше, когда страница уже отрисована в картинку, границу закрашивания
// дополнительно подгоняем под настоящие пиксели текста — так результат не зависит
// от того, насколько удачно угаданы веса символов для конкретного шрифта.
function buildInkColumns(ctx, xFrom, xTo, yTop, yBottom) {
  const x0 = Math.max(0, Math.floor(xFrom));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(xTo));
  const y0 = Math.max(0, Math.floor(yTop));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(yBottom));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return { x0, ink: [] };
  const data = ctx.getImageData(x0, y0, w, h).data;
  const ink = new Array(w).fill(false);
  for (let col = 0; col < w; col++) {
    for (let row = 0; row < h; row++) {
      const p = (row * w + col) * 4;
      const a = data[p + 3];
      if (a > 10 && (data[p] + data[p + 1] + data[p + 2]) / 3 < 200) {
        ink[col] = true;
        break;
      }
    }
  }
  return { x0, ink };
}

// ВАЖНО: подгонка границ умеет только РАСШИРЯТЬ область закрашивания, никогда не
// сужать её относительно исходной оценки. Более ранняя версия искала ближайший
// промежуток в обе стороны и могла принять обычный зазор МЕЖДУ соседними цифрами
// одного и того же номера (внутри самих персональных данных) за границу слова —
// из-за этого рамка могла "сжаться" и часть номера оставалась видна. Лучше слегка
// задеть соседнее слово, чем показать хотя бы один символ персональных данных,
// поэтому сдвиг возможен только наружу (шире), и только пока прямо на границе
// действительно есть текст, который иначе будет обрезан.

// Растягивает левую границу box'а влево, если ровно на границе ещё есть текст
// (значит, оценка обрезает символ) — до ближайшего настоящего пробела или до
// предела maxGrowPx. Никогда не сдвигает границу вправо.
function growLeftToCoverInk(ctx, estimatedX, yTop, yBottom, maxGrowPx) {
  const { x0, ink } = buildInkColumns(ctx, estimatedX - maxGrowPx, estimatedX, yTop, yBottom);
  if (ink.length === 0) return estimatedX;
  let i = ink.length - 1;
  if (!ink[i]) return estimatedX; // на границе уже пусто — расширять не нужно
  while (i >= 0 && ink[i]) i--;
  return x0 + Math.max(i, 0);
}

// Растягивает правую границу box'а вправо, если ровно на границе ещё есть текст.
// Никогда не сдвигает границу влево.
function growRightToCoverInk(ctx, estimatedX, yTop, yBottom, maxGrowPx) {
  const { x0, ink } = buildInkColumns(ctx, estimatedX, estimatedX + maxGrowPx, yTop, yBottom);
  if (ink.length === 0) return estimatedX;
  if (!ink[0]) return estimatedX; // на границе уже пусто — расширять не нужно
  let i = 0;
  while (i < ink.length && ink[i]) i++;
  return x0 + Math.min(i, ink.length - 1);
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
    it._charOffsets = computeCharOffsets(it);
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
  // itemRect/computeCharOffsets для каждого элемента уже вычислены в buildLines().
  const { str, charMap } = buildLineString(lineItems);
  const matches = window.PDN_DETECT_LINE(str);
  const rects = [];
  for (const match of matches) {
    if (!activeTypes.has(match.type)) continue;
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
      const offsets = item._charOffsets;
      const partial = {
        x0: item._rect.x0 + offsets[min],
        x1: item._rect.x0 + offsets[max + 1],
        y0: item._rect.y0,
        y1: item._rect.y1,
      };
      rect = rect ? unionRect(rect, partial) : partial;
    }
    rects.push(rect);
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
    const lines = buildLines(textContent.items);

    const redactionRects = [];
    for (const lineItems of lines) {
      redactionRects.push(...collectRedactionRects(lineItems, activeTypes));
    }

    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    ctx.fillStyle = "#000000";
    const GROW_MAX_PX = 14; // ~5.6pt при текущем масштабе рендера — предел расширения границы
    for (const rect of redactionRects) {
      const vp = viewport.convertToViewportRectangle([rect.x0, rect.y0, rect.x1, rect.y1]);
      let x = Math.min(vp[0], vp[2]);
      let xEnd = Math.max(vp[0], vp[2]);
      const y = Math.min(vp[1], vp[3]);
      const h = Math.abs(vp[3] - vp[1]);
      // Сужаем окно выборки по высоте, чтобы не задеть соседние строки сверху/снизу.
      const yTop = y + h * 0.15;
      const yBottom = y + h * 0.85;

      x = growLeftToCoverInk(ctx, x, yTop, yBottom, GROW_MAX_PX);
      xEnd = growRightToCoverInk(ctx, xEnd, yTop, yBottom, GROW_MAX_PX);

      const w = xEnd - x;
      ctx.fillRect(x - BOX_PADDING_PX, y - BOX_PADDING_PX, w + BOX_PADDING_PX * 2, h + BOX_PADDING_PX * 2);
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

  processBtn.disabled = false;
});
