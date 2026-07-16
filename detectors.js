// Поиск персональных данных в строке текста. Всё выполняется локально в браузере.
// Возвращает список {start, end, type} — непересекающихся диапазонов символов в строке.
// Приоритет детекторов сверху вниз: более специфичные форматы (СНИЛС/паспорт/телефон)
// разбираются раньше, чтобы не путать их с ИНН, а ИНН — раньше общей эвристики ФИО/адреса.

(function () {
  const FIRST_NAMES = window.PDN_FIRST_NAMES || new Set();
  const PATRONYMIC_SUFFIXES = window.PDN_PATRONYMIC_SUFFIXES || [];

  function overlaps(ranges, start, end) {
    return ranges.some((r) => start < r.end && end > r.start);
  }

  function addMatches(ranges, regex, str, type, priorityCheck) {
    let m;
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    while ((m = re.exec(str)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(ranges, start, end)) continue;
      if (priorityCheck && !priorityCheck(str, start, end, m)) continue;
      ranges.push({ start, end, type });
    }
  }

  function hasNearbyKeyword(str, pos, keywords, windowBefore = 20) {
    const from = Math.max(0, pos - windowBefore);
    const context = str.slice(from, pos).toLowerCase();
    return keywords.some((k) => context.includes(k));
  }

  const ADDRESS_KEYWORDS = [
    "г.", "город", "обл.", "область", "р-н", "район", "ул.", "улица",
    "пр-кт", "проспект", "пер.", "переулок", "д.", "дом", "кв.", "квартира",
    "shosse", "шоссе", "наб.", "набережная"
  ];

  function findAddressLine(str) {
    const lower = str.toLowerCase();
    const hasKeyword = ADDRESS_KEYWORDS.some((k) => lower.includes(k)) || /\b\d{6}\b/.test(str);
    if (!hasKeyword) return [];
    return [{ start: 0, end: str.length, type: "адрес" }];
  }

  function findFio(str, ranges) {
    // Фамилия И.О.
    addMatches(ranges, /[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]?\.?/g, str, "ФИО");

    // Последовательности из 2-3 слов с заглавной кириллической буквы
    const wordSeq = /(?:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+){1,2}[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?/g;
    let m;
    while ((m = wordSeq.exec(str)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(ranges, start, end)) continue;
      const words = m[0].split(/\s+/);
      const lastWord = words[words.length - 1].toLowerCase();
      const hasPatronymic = PATRONYMIC_SUFFIXES.some((suf) => lastWord.endsWith(suf));
      const hasKnownFirstName = words.some((w) => FIRST_NAMES.has(w.toLowerCase()));
      if (hasPatronymic || hasKnownFirstName) {
        ranges.push({ start, end, type: "ФИО" });
      }
    }
  }

  function detectLine(str) {
    const ranges = [];

    // СНИЛС: 11 цифр в формате XXX-XXX-XXX XX (с пробелами/дефисами опционально)
    addMatches(ranges, /\b\d{3}[- ]?\d{3}[- ]?\d{3}[ ]?\d{2}\b/, str, "СНИЛС");

    // Паспорт РФ: 4 + 6 цифр, приоритет рядом со словами паспорт/серия/№
    addMatches(ranges, /\b\d{2}\s?\d{2}\s?\d{6}\b/, str, "паспорт", (s, start) =>
      hasNearbyKeyword(s, start, ["паспорт", "серия", "№"], 25)
    );

    // Телефон
    addMatches(ranges, /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b/, str, "телефон");

    // ИНН: 10 или 12 цифр
    addMatches(ranges, /\b\d{12}\b/, str, "ИНН");
    addMatches(ranges, /\b\d{10}\b/, str, "ИНН");

    // ФИО
    findFio(str, ranges);

    // Адрес — если строка похожа на адрес, закрашиваем её целиком (даже если она
    // пересекается с уже найденными точечными диапазонами выше — перекрытие при
    // закрашивании не проблема, лишний раз залить чёрным те же пиксели безопасно).
    ranges.push(...findAddressLine(str));

    ranges.sort((a, b) => a.start - b.start);
    return ranges;
  }

  window.PDN_DETECT_LINE = detectLine;
})();
