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
    "шоссе", "наб.", "набережная", "н.п.", "тер.", "участок", "участки"
  ];

  // Ключевые слова адреса без точки — это целые слова ("дом", "город" и т.п.),
  // и искать их простым includes() опасно: например, "дом" — это ещё и
  // подстрока слова "судом" ("рассмотрено судом" — про суд, не про адрес).
  // Сокращения с точкой ("г.", "д.", "ул." и т.п.) страдают ОБРАТНОЙ версией той
  // же проблемы: точка сама по себе не спасает, потому что это ещё и обычная
  // точка конца предложения после слова, оканчивающегося на ту же букву —
  // например, "период." выглядит как "д." (сокращение "дом"), хотя это конец
  // фразы, никакого дома тут нет. Поэтому для ЛЮБого ключевого слова проверяем,
  // что слева нет кириллической буквы (аналог \b, который для кириллицы в JS не
  // работает); для слов без точки — дополнительно и справа.
  function isWholeWordMatch(lower, keyword, idx) {
    const before = idx > 0 ? lower[idx - 1] : "";
    const cyrLetter = /[а-яё]/;
    if (cyrLetter.test(before)) return false;
    if (keyword.endsWith(".")) return true;
    const after = idx + keyword.length < lower.length ? lower[idx + keyword.length] : "";
    return !cyrLetter.test(after);
  }

  // Возвращает индекс первого настоящего совпадения ключевого слова, либо -1.
  function findKeywordIndex(str, lower, keyword) {
    let idx = 0;
    while ((idx = lower.indexOf(keyword, idx)) !== -1) {
      if (isWholeWordMatch(lower, keyword, idx)) {
        if (!(keyword === "г." && isYearAbbreviation(str, lower, idx))) return idx;
      }
      idx += keyword.length;
    }
    return -1;
  }

  // "г." после даты/года — это сокращение "года" ("2025 г.", "04.08.2025 г."),
  // а не города, хотя выглядит совершенно так же. Сюда же "г.р." (год рождения).
  // Отдельный случай — перенос строки: если в оригинале было "...от 13.03.2025 г.,
  // № 222..." и разбиение на строки/OCR разорвало текст ровно после "г.", то в
  // строке, где обрабатывается остаток, "г." окажется САМЫМ ПЕРВЫМ, без цифры перед
  // собой (она осталась в предыдущей строке) — предыдущая проверка это не ловит.
  // Поэтому дополнительно требуем, чтобы после настоящего городского "г." шло
  // название города (слово с большой буквы) — а не запятая/точка с запятой/цифра,
  // как бывает у оборванного "г." от "года".
  function isYearAbbreviation(str, lower, idx) {
    if (lower.slice(idx, idx + 4) === "г.р.") return true;
    const before = lower.slice(Math.max(0, idx - 6), idx);
    if (/\d\s*$/.test(before)) return true;
    const after = str.slice(idx + 2).replace(/^[\s,;]+/, "");
    return !/^[А-ЯЁ]/.test(after);
  }

  function findAddressLine(str) {
    // Проверяем явные ключевые слова адреса — отдельный 6-значный индекс сам по
    // себе не считается признаком адреса (иначе под удар попадал бы любой
    // случайный 6-значный номер в документе, например часть номера паспорта).
    const lower = str.toLowerCase();
    const keywordIndices = ADDRESS_KEYWORDS
      .map((k) => findKeywordIndex(str, lower, k))
      .filter((i) => i !== -1);
    if (keywordIndices.length === 0) return [];
    const boundary = Math.min(...keywordIndices);

    // Начало закраски сужаем ДО САМОГО АДРЕСА только если перед ним есть явный
    // разделитель — двоеточие ("Место оказания услуг: 123456, обл. ..." → всё
    // до двоеточия не адрес и не персональные данные). Без двоеточия начало НЕ
    // сужаем и берём всю строку с начала — название района/местности может
    // стоять раньше первого найденного слова в той же строке ("Приморский,
    // н.п. Заречное..." — "Приморский" относится к адресу, хотя "н.п."
    // находится только дальше), и его нельзя терять.
    const lastColon = str.lastIndexOf(":", boundary);
    const start = lastColon !== -1 ? lastColon + 1 : 0;

    return [{ start, end: str.length, type: "адрес" }];
  }

  // Адрес часто переносится на следующую визуальную строку ровно на границе
  // "название улицы" / "номер дома" — там нет ни одного адресного ключевого
  // слова (оно осталось на предыдущей строке), поэтому findAddressLine строку-
  // продолжение саму по себе не находит ("Книповича 25" после "г. Мурманск,
  // ул. академика" на предыдущей строке). Без контекста такой шаблон опасно
  // ловить безусловно — "Глава 5", "Приложение 3" выглядят точно так же, но
  // адресом не являются. Поэтому это применяется ТОЛЬКО если предыдущая строка
  // уже была признана адресом — тогда это, скорее всего, её продолжение.
  const ADDRESS_CONTINUATION_RE = /^[А-ЯЁ][а-яёЁ]+(?:[\s-][А-ЯЁ][а-яёЁ]+)?,?\s*\d{1,5}[а-яёА-ЯЁ]?(?:[\/\-]\d+[а-яёА-ЯЁ]?)?\.?$/;

  function looksLikeAddressContinuation(str) {
    return ADDRESS_CONTINUATION_RE.test(str.trim());
  }

  // Дата рождения — числовые (01.01.1990) и текстовые (1 января 1990 г.) форматы.
  // Закрашиваем только если рядом есть слово-триггер ("дата рождения", "родился",
  // "г.р." и т.п.) — иначе под закраску попадала бы вообще любая дата в документе
  // (дата составления, срок, дедлайн и т.п.), не имеющая отношения к персональным
  // данным. Ключевые слова здесь достаточно длинные и специфичные, поэтому ищем их
  // простым includes() (как "паспорт"/"серия" выше) — в отличие от коротких слов
  // адреса, случайно встретить "рожден"/"г.р." внутри не связанного слова маловероятно.
  //
  // ВАЖНО: триггер должен быть РЯДОМ именно с этой датой (hasNearbyKeyword с окном
  // до и после), а не просто где-то в той же строке — иначе если строка/абзац
  // содержит ОБЕ даты (рождения и, например, дату документа), триггер "рождения"
  // включал бы поиск по всей строке и закрашивал бы вообще любую дату в ней,
  // не только ту, что рядом с меткой.
  const BIRTH_KEYWORDS = ["дата рождения", "рожден", "рождён", "родил", "г.р."];
  const MONTH_NAMES = "(?:январ[яь]|феврал[яь]|март[а]?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|август[а]?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь])";
  const DATE_NUMERIC_RE = /\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/g;
  const DATE_TEXT_RE = new RegExp(`\\b\\d{1,2}\\s+${MONTH_NAMES}\\s+\\d{4}\\s*(?:г\\.?|года)?`, "gi");

  function hasNearbyBirthKeyword(str, start, end, windowSize = 35) {
    const before = str.slice(Math.max(0, start - windowSize), start).toLowerCase();
    const after = str.slice(end, Math.min(str.length, end + windowSize)).toLowerCase();
    return BIRTH_KEYWORDS.some((k) => before.includes(k) || after.includes(k));
  }

  // Год рождения иногда пишут без дня/месяца — просто "1985 года рождения" или
  // "1985 г.р." (очень частый оборот в шапках документов). Год сам по себе —
  // слишком общее число, чтобы закрашивать его без ТЕСНОЙ привязки к метке сразу
  // после (в отличие от полной даты выше, где хватает триггера рядом) — поэтому
  // здесь метка обязана идти вплотную после года. Закрашивается только сам год —
  // "года рождения"/"г.р." остаются видимыми, как и подпись у полной даты.
  const BARE_YEAR_RE = /\b((?:19|20)\d{2})\s*(?:года?\s+рождения|г\.р\.)/gi;

  function findBirthDates(str, ranges) {
    // Сначала полная дата (день.месяц.год) — если она есть, "год" внутри нее
    // уже займёт диапазон, и BARE_YEAR_RE ниже (проверяющий overlaps) корректно
    // не станет заново закрашивать один только год, обрезая день/месяц. Если
    // делать в обратном порядке, короткий матч на голый год встаёт первым и
    // "перехватывает" год внутри полной даты — день/месяц остаются не закрашены.
    addMatches(ranges, DATE_NUMERIC_RE, str, "дата рождения", (s, start, end) =>
      hasNearbyBirthKeyword(s, start, end)
    );
    addMatches(ranges, DATE_TEXT_RE, str, "дата рождения", (s, start, end) =>
      hasNearbyBirthKeyword(s, start, end)
    );

    let m;
    BARE_YEAR_RE.lastIndex = 0;
    while ((m = BARE_YEAR_RE.exec(str)) !== null) {
      const start = m.index;
      const end = start + m[1].length;
      if (!overlaps(ranges, start, end)) ranges.push({ start, end, type: "дата рождения" });
    }
  }

  // Ссылки на статьи закона ("ст. 125 УПК РФ", "статья 158 ч. 2 УК РФ" и т.п.) —
  // это не персональные данные, их нужно оставлять видимыми даже если они попали
  // на одну строку/абзац с реальными ПДн (например, из-за того, что OCR склеил
  // несколько визуальных строк в одну, или сработала эвристика адреса, красящая
  // строку целиком). Поэтому такие диапазоны сначала находятся отдельно, а затем
  // в конце detectLine вырезаются из ЛЮБЫХ найденных диапазонов закраски — что бы
  // их ни вызвало.
  // \b здесь не подходит: JS считает кириллические буквы "не-словесными" для \b,
  // поэтому граница между пробелом и русской буквой не определяется — вместо
  // этого явно проверяем, что до/после матча нет ещё одной кириллической буквы
  // (защита от срабатывания на "ст" внутри слова вроде "быстро"/"состав").
  const CYR = "А-ЯЁа-яё";
  const STATUTE_RE = new RegExp(
    `(?<![${CYR}])[Сс][Тт](?:атья|атьи)?\\.?\\s*\\d+(?:\\.\\d+)?(?:\\s*,?\\s*ч(?:асть|асти)?\\.?\\s*\\d+)?\\s+[А-ЯЁ][а-яёА-ЯЁ]{1,7}(?:\\s+РФ)?(?![${CYR}])`,
    "g"
  );

  function findStatuteRefs(str) {
    const refs = [];
    let m;
    STATUTE_RE.lastIndex = 0;
    while ((m = STATUTE_RE.exec(str)) !== null) {
      refs.push({ start: m.index, end: m.index + m[0].length });
    }
    return refs;
  }

  function subtractProtected(ranges, protectedRanges) {
    if (!protectedRanges.length) return ranges;
    let pieces = ranges;
    for (const p of protectedRanges) {
      const next = [];
      for (const piece of pieces) {
        if (p.end <= piece.start || p.start >= piece.end) {
          next.push(piece);
          continue;
        }
        if (p.start > piece.start) next.push({ start: piece.start, end: Math.min(p.start, piece.end), type: piece.type });
        if (p.end < piece.end) next.push({ start: Math.max(p.end, piece.start), end: piece.end, type: piece.type });
      }
      pieces = next;
    }
    return pieces.filter((r) => r.end > r.start);
  }

  // Если в строке явно написано "ИНН:", "СНИЛС", "паспорт", "телефон" — редактируем
  // весь идущий следом ряд цифр, каким бы ни было его точное количество. Это подстраховка
  // на случай опечаток/нестандартного формата, когда точные регексы ниже промахиваются
  // (например, ИНН из 13 цифр вместо 10/12 всё равно должен быть скрыт, раз он так подписан).
  // Паспортные данные часто пишут как "серия 45 07 номер 123456" — серия и номер
  // разделены словом "номер", так что это НЕ один непрерывный ряд цифр. Поэтому у
  // паспорта несколько меток-триггеров, и КАЖДОЕ вхождение любой метки (а не только
  // первое) ищет свой ряд цифр следом — иначе при формате "серия ... номер ..."
  // находилась бы только "серия", а "номер" оставался бы не закрашенным.
  // "номер"/"№" сами по себе — слишком общие слова (номер дела, статьи, квартиры,
  // исполнительного производства и т.п.), поэтому их триггерят только в паре со
  // словом "паспорт"/"серия" где-то в той же строке — иначе, например, "дело
  // № 125" или "ст. 125 УПК РФ" ошибочно закрашивались бы как паспорт.
  const LABELS = [
    // ИНН из 10 цифр — это всегда ИНН ОРГАНИЗАЦИИ (у физлиц ИНН из 12 цифр),
    // то есть не персональные данные — исключаем эту длину, даже если она
    // явно подписана словом "ИНН" (в справках банков и т.п. рядом со словом
    // "ИНН" почти всегда указан именно ИНН самой организации, не человека).
    { re: /инн/gi, type: "ИНН", excludeDigitCounts: [10] },
    { re: /снилс/gi, type: "СНИЛС" },
    // ОГРН/ОГРНИП — 13/15 цифр. minDigits защищает от случайных коротких чисел
    // рядом со словом "ОГРН" (например, года "2024"), которые не могут быть
    // настоящим ОГРН, но раньше подходили под общий "ряд из 3+ цифр".
    { re: /огрнип|огрн/gi, type: "ОГРН", minDigits: 12 },
    { re: /паспорт|серия/gi, type: "паспорт" },
    { re: /номер|№/gi, type: "паспорт", contextWords: ["паспорт", "серия"] },
    { re: /телефон|тел\.|моб\./gi, type: "телефон" },
  ];

  function findLabeledDigitRuns(str, ranges) {
    const lower = str.toLowerCase();
    for (const { re, type, contextWords, excludeDigitCounts, minDigits } of LABELS) {
      if (contextWords && !contextWords.some((w) => lower.includes(w))) continue;
      let labelMatch;
      re.lastIndex = 0;
      while ((labelMatch = re.exec(str)) !== null) {
        const searchFrom = labelMatch.index + labelMatch[0].length;
        const windowStr = str.slice(searchFrom, Math.min(str.length, searchFrom + 40));
        const digitRun = /\d[\d \-]{2,}\d|\d{3,}/.exec(windowStr);
        if (!digitRun) continue;
        const digitCount = (digitRun[0].match(/\d/g) || []).length;
        if (excludeDigitCounts && excludeDigitCounts.includes(digitCount)) continue;
        if (minDigits && digitCount < minDigits) continue;
        const start = searchFrom + digitRun.index;
        const end = start + digitRun[0].length;
        if (!overlaps(ranges, start, end)) ranges.push({ start, end, type });
      }
    }
  }

  // Частые заглавные слова в начале предложения, которые не являются именами
  // (местоимения, глаголы) — исключаем их из найденных последовательностей ФИО,
  // чтобы не закрашивать соседние слова вместе с настоящим именем.
  const NAME_STOPWORDS = new Set([
    "я", "он", "она", "они", "мы", "вы", "ты", "это", "настоящим",
    "должен", "должна", "должны", "прошу", "сообщаю", "довожу", "уведомляю",
    "заявляю", "подтверждаю", "прошу", "настоящий", "данный", "данная",
  ]);

  function isKnownFirstName(word) {
    const w = word.toLowerCase();
    if (FIRST_NAMES.has(w)) return true;
    // Учитываем падежные окончания русских имён (Валерий -> Валерию/Валерия/Валерием):
    // сравниваем по "стеблю" имени без последних 1-2 букв. Порог ">6" (а не ">4",
    // как было раньше) — для имён длиной 5-6 букв отрезаем только 1 букву, а не 2:
    // иначе стебель получается слишком коротким и общим и совпадает со случайными
    // словами (например, "фили" от "Филипп" совпадало со словом "Филиал").
    for (const name of FIRST_NAMES) {
      const stem = name.length > 6 ? name.slice(0, -2) : name.slice(0, -1);
      if (stem.length >= 3 && w.startsWith(stem) && Math.abs(w.length - name.length) <= 2) {
        return true;
      }
    }
    return false;
  }

  // Слово ФИО — либо "Иванов" (заглавная + строчные), либо "ИВАНОВ" (капсом
  // целиком, часто встречается в официальных бланках и доверенностях). Само по
  // себе совпадение с этим паттерном ничего не решает — как и раньше, слово
  // всё равно проверяется дальше через словарь имён/окончание отчества
  // (isKnownFirstName/PATRONYMIC_SUFFIXES, они приводят к нижнему регистру перед
  // сравнением), так что более широкий паттерн не увеличивает риск ложных
  // срабатываний на случайные капсом написанные слова/аббревиатуры.
  const NAME_WORD = "(?:[А-ЯЁ][а-яё]+|[А-ЯЁ]{2,})";

  function findFio(str, ranges) {
    // Фамилия И.О.
    addMatches(ranges, new RegExp(`${NAME_WORD}\\s+[А-ЯЁ]\\.\\s?[А-ЯЁ]?\\.?`, "g"), str, "ФИО");

    // Последовательности из 2-3 слов с заглавной кириллической буквы
    const wordSeq = new RegExp(`(?:${NAME_WORD}(?:-${NAME_WORD})?\\s+){1,2}${NAME_WORD}(?:-${NAME_WORD})?`, "g");
    let m;
    while ((m = wordSeq.exec(str)) !== null) {
      let start = m.index;
      let end = start + m[0].length;
      const words = m[0].split(/\s+/);

      // Обрезаем стоп-слова с краёв (например, "Должен" перед именем).
      let from = 0;
      let to = words.length;
      while (from < to && NAME_STOPWORDS.has(words[from].toLowerCase())) from++;
      while (to > from && NAME_STOPWORDS.has(words[to - 1].toLowerCase())) to--;
      if (to - from < 1) continue;
      const trimmedWords = words.slice(from, to);

      if (from > 0 || to < words.length) {
        // Пересчитываем диапазон под обрезанные слова.
        const before = words.slice(0, from).join(" ");
        const offsetStart = start + (before.length > 0 ? before.length + 1 : 0);
        const kept = trimmedWords.join(" ");
        start = offsetStart;
        end = offsetStart + kept.length;
      }

      // Жадный поиск слов ограничен 2-3 словами — если спереди было обрезано
      // стоп-слово (например, "Должен"/"ДОЛЖЕН"), оно заняло один из этих слотов,
      // и настоящему ФИО (Фамилия Имя Отчество, 3 слова) могло не хватить места —
      // тогда отчество осталось бы за пределами найденного диапазона. Добираем
      // ещё до двух идущих следом слов ФИО, чтобы не терять хвост имени.
      if (from > 0) {
        const tailRe = new RegExp(`^(?:\\s+${NAME_WORD})`, "");
        let guard = 0;
        while (guard < 2) {
          const rest = str.slice(end);
          const tm = tailRe.exec(rest);
          if (!tm) break;
          end += tm[0].length;
          trimmedWords.push(tm[0].trim());
          guard++;
        }
      }

      if (overlaps(ranges, start, end)) continue;
      const lastWord = trimmedWords[trimmedWords.length - 1].toLowerCase();
      const hasPatronymic = PATRONYMIC_SUFFIXES.some((suf) => lastWord.endsWith(suf));
      const hasKnownFirstName = trimmedWords.some((w) => isKnownFirstName(w));
      if (hasPatronymic || hasKnownFirstName) {
        ranges.push({ start, end, type: "ФИО" });
      }
    }
  }

  function detectLine(str, prevLineWasAddress) {
    const ranges = [];
    const protectedRanges = findStatuteRefs(str);

    // Подписанные поля (ИНН:, СНИЛС, паспорт, телефон) — в первую очередь, чтобы
    // не зависеть от точного количества цифр в строгих регексах ниже.
    findLabeledDigitRuns(str, ranges);

    // Дата рождения — только рядом со словом-триггером (см. комментарий у функции)
    findBirthDates(str, ranges);

    // СНИЛС: 11 цифр в формате XXX-XXX-XXX XX (с пробелами/дефисами опционально)
    addMatches(ranges, /\b\d{3}[- ]?\d{3}[- ]?\d{3}[ ]?\d{2}\b/, str, "СНИЛС");

    // Паспорт РФ: 4 + 6 цифр, только рядом со словами паспорт/серия — "№" сюда
    // не включаем, слишком общий символ (номер дела/статьи/квартиры и т.п. в этом
    // же формате из 8 цифр иначе тоже закрашивался бы как паспорт).
    addMatches(ranges, /\b\d{2}\s?\d{2}\s?\d{6}\b/, str, "паспорт", (s, start) =>
      hasNearbyKeyword(s, start, ["паспорт", "серия"], 25)
    );

    // Телефон
    addMatches(ranges, /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b/, str, "телефон");

    // ИНН: только 12 цифр — у физлиц ИНН именно такой длины. 10-значный ИНН
    // всегда принадлежит организации (не персональные данные), поэтому его
    // не закрашиваем безусловно (см. также excludeDigitCounts у метки "ИНН" выше).
    addMatches(ranges, /\b\d{12}\b/, str, "ИНН");

    // ОГРН (13 цифр) / ОГРНИП (15 цифр) — регистрационный номер ИП относится к
    // конкретному физлицу, поэтому тоже считаем персональными данными.
    addMatches(ranges, /\b\d{15}\b/, str, "ОГРН");
    addMatches(ranges, /\b\d{13}\b/, str, "ОГРН");

    // Кадастровый номер: XX:XX:XXXXXXX:XX (регион:район:квартал:участок). Формат
    // с двоеточиями достаточно характерный, чтобы закрашивать без привязки к
    // ключевому слову рядом — случайно встретить его в обычном тексте маловероятно.
    addMatches(ranges, /\b\d{2}\s?:\s?\d{2}\s?:\s?\d{6,7}\s?:\s?\d{1,6}\b/, str, "кадастровый номер");

    // ФИО
    findFio(str, ranges);

    // Адрес — если строка похожа на адрес, закрашиваем её целиком (даже если она
    // пересекается с уже найденными точечными диапазонами выше — перекрытие при
    // закрашивании не проблема, лишний раз залить чёрным те же пиксели безопасно).
    const addressRanges = findAddressLine(str);
    ranges.push(...addressRanges);

    // Продолжение адреса на следующей визуальной строке (см. комментарий у
    // looksLikeAddressContinuation) — только если в этой строке адрес не
    // найден сам по себе и предыдущая строка уже была адресом.
    if (addressRanges.length === 0 && prevLineWasAddress && looksLikeAddressContinuation(str)) {
      ranges.push({ start: 0, end: str.length, type: "адрес" });
    }

    const finalRanges = subtractProtected(ranges, protectedRanges);
    finalRanges.sort((a, b) => a.start - b.start);
    return finalRanges;
  }

  window.PDN_DETECT_LINE = detectLine;
})();
