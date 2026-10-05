# Есть ли аналог caveman для русского языка?

> Вопрос пользователя: «есть ли аналог caveman для русского языка?»
> Расположение: `docs/` — в репо уже лежит исследовательская заметка [`research-semantic-compression.md`](research-semantic-compression.md), поэтому новая заметка добавлена рядом, по существующей конвенции.
> «Caveman» здесь = движок [`src/engines/caveman.ts`](../src/engines/caveman.ts): детерминистичная правка прозы списком regex-правил (pleasantries / filler / redundant openers / verbose connectors / emphasis) поверх замаскированных защищённых спанов (fence, inline code, URL, path, error head, stack line), с тремя уровнями интенсивности `lite`/`full`/`ultra`.
> Все фактические утверждения снабжены ссылками на первоисточники (arXiv-абстракты, канонические репозитории, официальные docs/сайты). Каждый источник прочитан напрямую. Локальные замеры помечены как **[эксперимент]** — их можно воспроизвести.

---

## 1. Резюме: три ответа

**1. Готового рабочего rule-based «русского caveman» нет. Но есть неработающая заготовка.**

В независимом открытом поиске самостоятельного regex-пака сжатия русской прозы не найдено (запросы и пустые результаты — §2.1). Однако в **апстрим-системе этого движка** — OmniRoute, откуда `RULES` портированы прямо по комментарию в коде ([`src/engines/caveman.ts:31`](../src/engines/caveman.ts): «ported from OmniRoute cavemanRules») — обнаруживается заготовка: [`open-sse/services/compression/rules/ru/`](https://github.com/diegosouzapw/OmniRoute/tree/release/v3.8.52/open-sse/services/compression/rules/ru) — 5 JSON-паков (`filler`, `context`, `structural`, `ultra`, `dedup`), 32 правила, уже в нужном этому репо формате (`pattern`/`replacement`/`minIntensity`/`flags`), описанном в [COMPRESSION_RULES_FORMAT.md](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/compression/COMPRESSION_RULES_FORMAT.md).

Это правило-пак **не работает**: из 32 правил на реалистичном русском тексте срабатывают 2 **[эксперимент, §3.2]**. Причина одна и системная: почти все паттерны обёрнуты в `\b`, а в JS-regex `\b` определён через ASCII-`\w` и для кириллицы не существует. Добавочная причина — пак полу-подключён: `languageDetector.ts` русский **распознаёт** (`ru` есть в `LANGUAGE_HINTS`, `listSupportedCompressionLanguages()` возвращает его, и на русском тексте детектор честно даёт `ru` **[эксперимент, §5.5]**), но директория `rules/ru/` **не внесена** ни в таблицу shipped-паков, ни в примеры конфигурации `enabledLanguagePacks` / `enabledPacks` — там только `en`, `es`, `pt-BR`, `id`, `it`, `de`, `fr`, `ja` ([COMPRESSION_LANGUAGE_PACKS.md](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/compression/COMPRESSION_LANGUAGE_PACKS.md)). То есть даже при идеальных regex русский пакет в дефолтной конфигурации не применялся бы.

Формулировка вывода (1) поэтому точная: **готового русского пакета, который сжимает, — нет; есть готовый лексикон (списки слов и классы правил), который нужно починить в одном месте, чтобы он заработал.** Это лучше, чем начинать с нуля.

**2. Ближайшие живые существующие артефакты — не regex, а стиль-промпты.**

Русская адаптация caveman в дикой природе существует, но решает задачу другим классом решений: [`krajcik/pi-russian-caveman`](https://github.com/krajcik/pi-russian-caveman) — расширение для **pi** ([`earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent)), **не** для omp. Механика: `before_agent_start` hook дописывает в system prompt ~755-символьный русский текст режима; сжимает **выход модели**, а не входящую прозу; уровни `lite/full/ultra`, toggle `/caveman`, персистентность в `~/.pi/agent/.caveman-active`, и auto-clarity carve-out (security warning / необратимые действия / неоднозначные шаги пишутся обычным языком) — см. [README](https://github.com/krajcik/pi-russian-caveman#readme) и [`extensions/caveman.ts`](https://github.com/krajcik/pi-russian-caveman/blob/main/extensions/caveman.ts). Родословная: [`JuliusBrussee/caveman`](https://github.com/JuliusBrussee/caveman) → [`@viartemev/pi-caveman`](https://pi.dev/packages/@viartemev/pi-caveman) → эта адаптация ([README: Attribution](https://github.com/krajcik/pi-russian-caveman#attribution)).

Это **не** конкурент движку этого репо (другой канал компрессии), но **ценный источник таксономии классов правил** — его русские инструкции перечисляют ровно те категории, что портируются в regex-пак: «приветствия, вводные слова, оговорки, повторы, лишние слова, рассказ о tool calls», шаблон `[что] [действие] [причина]`. Как готовые правила-замены их брать нельзя — это прозаические указания модели.

Та же картина у всех «caveman-локализованных» проектов: они промпт-стайл, а не regex.
- [`InterfaceX-co-jp/genshijin`](https://github.com/InterfaceX-co-jp/genshijin) (⭐ 332) — «caveman の日本語版» (японская версия caveman), оптимизирован под японские冗余-выражения (избыточные выражения):敬语 (вежливые `です/ます`), クッション言葉 (смягчители), 前置き表現 (предисловия), ぼかし (размывание); три уровня `丁寧/通常/極限`. Из «правил» в репо лежит единственный файл [`rules/genshijin-activate.md`](https://github.com/InterfaceX-co-jp/genshijin/tree/main/rules) — промпт-активатор, а не regex-пак **[эксперимент: листинг директории `rules/` содержит один `.md`]**.
- [`leninejunior/troglodita`](https://github.com/leninejunior/troglodita) (PT-BR, ~70% экономии output-токенов) — прямо объясняет, почему английский пак не переносится: «Português tem 8 artigos com concordância de gênero — remover todos quebra a compreensão; as muletas verbais do PT-BR são diferentes ("na verdade", "vale ressaltar", "basicamente")» ([README, раздел «Por que não usar o caveman?»](https://github.com/leninejunior/troglodita#por-que-não-usar-o-caveman)). Тоже skills/промпты.
- [`bbylw/caveman-cn`](https://github.com/bbylw/caveman-cn) — китайская локализация того же плана.
- [`artgas1/infostyle-skill`](https://github.com/artgas1/infostyle-skill) (⭐ 29) — «Claude Code skill for editing Russian text using Ilyakhov's information style», по книге «Пиши, сокращай» и сервису Главред ([README](https://github.com/artgas1/infostyle-skill#readme)). Внутри — **`references/stop-words.md` с 15 категориями стоп-слов** (вводные конструкции, усилители, паразиты времени, канцеляризмы, отглагольные существительные, модальные глаголы, страдательный залог) с готовыми трансформациями ([файл](https://github.com/artgas1/infostyle-skill/blob/main/skills/infostyle/references/stop-words.md)). Это снова промпт (редактирует модель, значит недетерминированно), но **классы правил и примеры замен — прямо в копилку** (§5.1).

Промежуточный вывод по (2): для русского есть богатая **методология** и **лексикон**, есть промпт-адаптации, нет работающего **детерминистичного regex-движка**.

**3. Исследовательская линия (sentence compression для русского) существует, но в академическом состоянии, не в прод-инструменте.**

Задача «удалить слова из предложения, оставив порядок» для русского поставлена и имеет датасет: [Kuvshinova, «Sentence compression for Russian: dataset and baselines», Dialogue 2020](https://dialogue-conf.org/media/5106/kuvshinovat-050.pdf) — 2 955 пар, построенных из корпуса парафраз-плагиата ParaPlag; biLSTM даёт f1 74,8%, читаемость 3,84 / информативность 3,29 из 5 (gold: 4,68 / 4,03). Важное для нас: автор **вводит post-hoc синтаксический оценщик** (компрессия должна оставаться подграфом дерева зависимостей исходника) именно потому, что нейромодели ломают грамматику и смысл — например удаляют отрицание: `К тому времени Фрида уже не могла встать с постели` → `Фрида могла встать с постели` (стр. 10). С оценщиком f1 до 81,3%, но «система удаляет лишь ~15–20% слов в среднем», а часть предложений вообще не сжимается. Это прямое подтверждение: **даже обученный экстрактор хуже детерминированного списка, когда нужен надёжный результат** (§5.4).

---

## 2. Столп A. Прямой аналог: честный пустой результат

### 2.1. Запросы, которые дали пусто

Поиск выполнялся двуслойно: `web_search` + GitHub Search API (`/search/repositories`), потому что веб-поиск по русским запросам возвращает блог-контент о «словах-паразитах», а не код.

GitHub API, `total_count = 0`:

| Запрос | Результат |
|---|---|
| `сжатие текста правил` | 0 |
| `слова-паразиты python` | 0 |
| `filler words russian removal` | 0 |
| `prose compression russian` | 0 |
| `caveman python regex filler` | 0 |
| `сокращаем текст библиотека` | 0 |
| `russian filler words strip library` | 0 |
| `russian text condense rules library github` | 0 |
| `antiwater russian text library` | 0 |
| `caveman language pack` | 0 |
| `caveman skill russian` | 0 |
| `лексифорг` | 0 |

`caveman russian` → **total_count = 1** и это ровно [`krajcik/pi-russian-caveman`](https://github.com/krajcik/pi-russian-caveman) (промпт-режим, см. §1, ответ 2).
`caveman ru` → 18, все нерелевантны (игры CavemanRun, `caveman-cn`, [`ether-btc/rust-cave-001`](https://github.com/ether-btc/rust-cave-001) — Rust/PyO3-порт **английского** компрессора).
`главред` → 4 репо, и все они — **клиенты закрытого API**, не правила: [`nlopin/glvrd-wordpress`](https://github.com/nlopin/glvrd-wordpress), [`shvetsgroup/atom-glvrd`](https://github.com/shvetsgroup/atom-glvrd), [`mihdan/mihdan-glvrd`](https://github.com/mihdan/mihdan-glvrd), [`VVSite/gravred-tgm-txtopt`](https://github.com/VVSite/gravred-tgm-txtopt).

Правила самого Главреда **не открыты**: сервис — «самая большая база правил, стоп-слов, примеров и ссылок» автора Максима Ильяхова, платформенный разработчик Анатолий Буров, с 1 декабря 2014 ([glvrd.ru/about](https://glvrd.ru/about/)); программный доступ — **платный HTTP/JS API** с договором и прайсом, документация в внешнем Notion/Google Doc ([glvrd.ru/api](https://glvrd.ru/api/)). Плагин для WordPress, Atom и т.п. — только тонкие клиенты к этому API. Вывод: **эталонная русская rule-база существует как продукт и не существует как open source.**

### 2.2. Что всё-таки открыто и релевантно

Два открытых носителя русских правил по теме, ни один не является компрессором:

**LanguageTool (модуль `ru`).** Русский официально поддерживается: на странице языков LanguageTool указан с 892 XML-правилами, 20 Java-правилами и проверкой орфографии — при **0 коммитов к русским правилам за последние 6 месяцев** ([Supported Languages](https://dev.languagetool.org/languages), срез «Rules in LanguageTool 6.6», дата 2025-03-27). Сам репозиторий описывает себя как «Style and Grammar Checker for 25+ Languages» ([README](https://github.com/languagetool-org/languagetool)). Правила лежат в [`languagetool-language-modules/ru/.../rules/ru/grammar.xml`](https://github.com/languagetool-org/languagetool/blob/master/languagetool-language-modules/ru/src/main/resources/org/languagetool/rules/ru/grammar.xml).

Разбор этого файла на `master` **[эксперимент]**: **911** элементов `<rule>` в 300 `<rulegroup>` (расхождение с «892» на официальной странице объясняется версией: страница считает срез 6.6 от 2025-03-27, а `master` уже ушёл вперёд). Категории: `LOGIC` («Логические ошибки»), `STYLE` («Стиль»), `GRAMMAR`, `PUNCTUATION`, `TYPOGRAPHY`, `TYPOS`, `CASING`, `EXTEND`. Метки `<short>` по убыванию: `Логическая ошибка` 98, `Тавтология` **50**, `Устойчивое выражение` 10, `Языковая избыточность` 5, `Повтор слова` 4, `Слова-паразиты` **3**, `Разговорная форма` 3, `Загруженность местоимениями` 1, `Канцелярский штамп` 1. Из 911 правил 13 помечены `default="off"` напрямую и ещё 8 rulegroup'ов выключены на уровне группы; 35 правил несут `tags="picky"`. Плеоназмы/тавтологии живут в `LOGIC`, слова-паразиты и разговорные формы — в `STYLE`.

Примеры дословно из файла (обратите внимание: `<suggestion>` — это и есть готовая правка, которую можно применить механически):

```xml
<rulegroup id="SPUSKATSJA_VNIZ" name="Тавтология: «спускаться вниз»">
  <rule>
    <pattern>
      <token regexp="yes" inflected="yes">спускаться|подниматься</token>
      <token regexp="yes">вниз|вверх</token>
    </pattern>
    <message>Языковая избыточность: <suggestion>\1</suggestion>?</message>
    <short>Языковая избыточность</short>
    <example correction="спускался">Он <marker>спускался вниз</marker> по лестнице.</example>
  </rule>
</rulegroup>

<rulegroup id="GLAVNAJA_SUT" name="Тавтология: «главная суть»">
  <pattern><token inflected="yes">главный</token><token>суть</token></pattern>
  <message>Языковая избыточность (плеоназм): <suggestion>\2</suggestion>?</message>
</rulegroup>

<rulegroup id="po_povodu_togo" name="Канцелярский штамп: «по поводу того»" tags="picky">
  <pattern><token>по</token><token>поводу</token><token>того</token></pattern>
  <message>Канцелярский штамп: <suggestion>о том</suggestion>?</message>
</rulegroup>

<!-- «Слова-паразиты»: удаление вместе с обеими обрамляющими запятыми —
     ровно та форма, которая нужна нашему движку (§5.2, п. 2).
     rulegroup id="tak_skazat", имя «Слова-паразиты: «так сказать»» -->
<rule>
  <pattern><token>,</token><token>так</token><token>сказать</token><token>,</token><token></token></pattern>
  <message>Слова-паразиты: <suggestion> \5</suggestion>.</message>
  <short>Слова-паразиты</short>
</rule>
```

Значимость для нас тройная. (а) Это **подтверждение переносимости классов**: избыточность формулируется как пары/короткие фразы, а не как морфологические формы. (б) Это **образец решения проблемы флексий**: вместо перечисления словоформ — `inflected="yes"` (330 употреблений) и `postag=` (1853) **[эксперимент]**; именно этот подход придётся воспроизводить (§5.3). (в) Правило `Слова-паразиты` показывает корректную форму записи для русского: удаляемый оборот вместе с **обеими** запятыми, а остаток фразы подхватывается токеном-переменной — тот самый паттерн, который сломан в апстрим-`ru`-паке.

Ограничения: LanguageTool не переписывает текст, а выдаёт подсказки (`<suggestion>`), то есть это lint, а не компрессор; работает на Java с собственным POS-слоем; и, по официальной статистике, русские правила не редактировались за последние полгода ([Supported Languages](https://dev.languagetool.org/languages)) — как донор словаря он пригоден, как зависимость рантайма — нет.

**ruTS (`SergeyShk/ruTS`)** — «Библиотека для извлечения статистик из текстов на русском языке» ([README](https://github.com/SergeyShk/ruTS)), MIT, Python ≥3.11 ([LICENSE.txt](https://github.com/SergeyShk/ruTS/blob/master/LICENSE.txt)). Это **не** компрессор, но внутри лежат **готовые машиночитаемые русские списки**, которые и есть топливо для rules-pack. Модуль [`StyleStats`](https://sergeyshk.github.io/ruTS/stats/style_stats/) считает SEO-метрики стиля по образцу Advego/Text.ru — «тошнота, водность, заспамленность, естественность по Ципфу, плотность ключевых слов, лексические маркеры канцелярита»; в документации прямо: «Лексические маркеры канцелярита: отглагольные существительные, производные предлоги, вводные слова, штампы — по спискам `COMPOUND_PREPOSITIONS`, `PARENTHETICALS` и `OFFICIALESE_CLICHES` из `ruts.constants`», а «стоп-слова для водности определяются по части речи с помощью pymorphy3» ([там же](https://sergeyshk.github.io/ruTS/stats/style_stats/)).

Разбор [`ruts/constants.py`](https://github.com/SergeyShk/ruTS/blob/master/ruts/constants.py) **[эксперимент, AST]**:

| Константа | Единиц | Примеры |
|---|---|---|
| `PARENTHETICALS` | 36 | `таким образом`, `как правило`, `в частности`, `кроме того`, `тем не менее`, `в свою очередь`, `по сути`, `по сути дела`, `на самом деле`, `иными словами`, `в принципе`, `к сожалению`, `может быть`, `как известно` |
| `COMPOUND_PREPOSITIONS` | 48 | `в целях`, `в связи с`, `в соответствии с`, `в ходе`, `в рамках`, `в случае`, `в отношении`, `в силу`, `во избежание`, `по причине` |
| `OFFICIALESE_CLICHES` | 89 | `на сегодняшний день`, `в настоящее время`, `в данный момент`, `на данном этапе`, `иметь место быть`, `в кратчайшие сроки`, `должным образом`, `в полном объеме`, `в обязательном порядке` |

Плюс `VERBAL_NOUN_LEMMAS` (18 отглагольных существительных: `производство`, `руководство`, `вмешательство`), `VERBAL_NOUN_SUFFIXES` (6 суффиксов: `ние`, `нье`, `тие`, `тье`, `ствие`, `ция`), `LIGHT_VERBS` (51: `осуществлять`, `производить`, `проводить`, `обеспечивать`, `оказывать`) и `SPLIT_PREDICATE_NOUNS` (32 пары «существительное → глаголы»: `роль`→`выполнять`, `оценка`→`давать`) — то есть готовые пары для правил «расщеплённое сказуемое → один глагол» и «отглагольное существительное → глагол». Отдельно полезно: `CohesionStats` считает «плотность коннекторов на 1000 слов по классам (причинные, противительные, уступительные, временные, аддитивные, условные, переформулирующие) и типам по собственному словарю из 317 единиц» ([README](https://github.com/SergeyShk/ruTS#возможности)) — это **готовый типизированный словарь русских связок** для правила `verbose_connectors`.

Есть и визуализация «подсветка текста в стиле Главреда» по 15 слоям в пяти группах: читаемость / синтаксис (пассив, обороты, цепочки родительных, расщеплённые сказуемые) / канцелярит ([дока](https://sergeyshk.github.io/ruTS/visualizers/zipf/)). Вывод: **русский аналог списка fillers существует в open source — это `ruts.constants`**, и он лицензионно чист (MIT) для заимствования.

---

## 3. Состояние текущего движка на русском (почему «ничего не происходит»)

Прочитано в [`src/engines/caveman.ts`](../src/engines/caveman.ts): `RULES` строки 32–94 — 11 правил, все English-only; `extractProtected()` 97–114; гейты `MIN_TEXT_LENGTH = 50`, `HAS_SPECIAL_CHARS_RE`, `PROTECTED_STRUCTURE_RE` (11–12), `isCodeDominant()` (128–133); `recapitalizeSentences()` (124–126).

### 3.1. Замеры на этом движке **[эксперимент]**

| Вход | Что происходит |
|---|---|
| `Очень важно проверить этот путь. Кроме того, нужно учесть кейс. Помимо этого, как бы сказать.` | `FIRED: []` — **ноль правил**, output === input, стадия даёт `no-gain` |
| `Привет! Спасибо, что helped. Я бы хотел very slowly реализовать a approach для того чтобы как бы сделать факторинг.` | `FIRED: [articles, emphasis_removal]` → `Я бы хотел slowly реализовать approach для того чтобы как бы сделать факторинг.` (−7 симв.) — **английские правила вырезают `very` и `a` из смешанного RU/EN текста**, русская часть (`для того чтобы`, `как бы`) не сжимается вообще |
| `Очень важно. Кроме того, см. src/engines/caveman.ts — там 1.2.3 версия.` | `masked_has=true, masked_prot=true` → правило-фаза **скипается целиком** (номер версии 1.2.3 триггерит `PROTECTED_STRUCTURE_RE`) |
| чистая русская проза без цифр/путей | гейт **не** срабатывает, правила запускаются и не находят совпадений |

Практический смысл: сейчас движок на русском не «вреден», а **инертен**; настоящая опасность — смешанный RU/EN-текст (стандарт для агентских логов: русская проза + английские идентификаторы), где `articles` (`/\b(?:a|an|the)\s+(?=[a-z])/g`) и `emphasis` вырезают английские слова из середины предложения, оставляя русскую часть нетронутой. Это асимметричная порча, а не нейтральность.

### 3.2. Почему апстрим-`ru` пакет не работает: `\b` и кириллица в JS

Ключевая находка. Проверено в этом рантайме (Node 22.12.0) **[эксперимент]**:

```
"К".match(/\w/)                       => null
/\b(?:конечно|безусловно)\b[,.!?\s]*/gi  на "Конечно, помогу…"  => SILENT (0 matches)
/\bконечно\b/gi                           => SILENT
/(?:конечно|безусловно)[,.!?\s]*/gi      => FIRES
/(?<!\p{L})(?:конечно|безусловно)(?!\p{L})[,.!?\s]*/giu  => FIRES
```

`\b` в ECMAScript = граница между `\w` и не-`\w`, а `\w` = `[A-Za-z0-9_]`. Кириллическая буква **не** является `\w`, поэтому «границы слова» вокруг русского слова не возникает никогда. Отсюда — полный аудит апстрим-пака **[эксперимент]**:

```
текст #1: FIRED 2/32  (filler/redundant_openers, ultra/ultra_punctuation)  → экономия 5.0%
текст #2: FIRED 2/32  (context/known_fact_hedging, ultra/ultra_punctuation) → экономия 6.6%
после замены \b → (?<!\p{L})…(?!\p{L}): ~14 и ~9 правил из 32 начинают срабатывать
```

`redundant_openers` срабатывает лишь потому, что написан без `\b`: `^(?:Привет|Здравствуйте|Добрый день|…)\s*[,.!?\s]?\s*`. `known_fact_hedging` — потому что использует `(?<=\.)`, а он к алфавиту не относится.

Помимо `\b`, в апстрим-паке есть три отдельных дефекта **[эксперимент]**, которые нельзя унаследовать:

1. **Удаление без замены рвёт связность.** `structural/forbidden_abbreviations_dots` с `replacement: ""` для `т.к.|т.е.|см.|напр.` превращает `Это т.к. ошибка.` в `Это  ошибка.` — теряется причинная связь, а `см.` — это ссылка на файл/раздел, то есть **сигнальный**, а не декоративный токен.
2. **`ultra_compression_articles` / `..._conjunctions` подставляют литеральный `—`** как «replacement» вместо удаления, то есть добавляют символ вместо того, чтобы считать экономию; для нашей метрики savings это фиктивная правка.
3. **`ultra_punctuation` = `[,:;]\s+ → " "`** — сносит разделитель после `Файл:` и `конфиг,`: `Файл: конфиг, версия 2.` → `Файл конфиг версия 2.` Это ломает читаемую структуру, ради которой в движке уже существуют protected spans.

Ещё одна ловушка, видимая из замера: `filler/pleasantries` и `filler/hedging` удаляют **вводное слово**, не поглощая парную запятую. Русский вводный член обрамляется **двумя** запятыми, поэтому «слово + хвостовой класс пунктуации» оставляет висячую запятую: `Это, возможно, займёт время.` → `Это, займёт время.` **[эксперимент]**. Корректный паттерн поглощает обе: `[ ,]*(?<!\p{L})(?:возможно)(?!\p{L})[ ,]*` → `Это займёт время.` Рабочий конвейер из четырёх таких правил даёт на тесте `Конечно, очень важно. В целом, это, возможно, займёт время. Это, на самом деле, просто.` → `важно. это займёт время. Это просто.` и **идемпотентен** (второй проход === первый) **[эксперимент]** — что критично, поскольку апстрим сам требует: «Keep rules idempotent: running the same filter twice should not corrupt output» ([COMPRESSION_RULES_FORMAT.md, Safety Rules](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/compression/COMPRESSION_RULES_FORMAT.md)).

### 3.3. Два места в движке, где `a-z` захардкожен

Не только правила — инфраструктура тоже англоцентрична **[код]**:

- [`recapitalizeSentences()`](../src/engines/caveman.ts) — `/(^|[.!?]\s+)([a-z])/g`. На кириллице **никогда не срабатывает**: `очень важно. как бы. далее.` остаётся в нижнем регистре. Проверено: с `\p{Ll}` и флагом `u` — `Очень важно. Как бы. Далее.` **[эксперимент]**. То есть после первого же working-русского `lite`-правила, удаляющего начало предложения, заглавная буква не восстановится.
- `PROTECTED_STRUCTURE_RE` содержит `\b\d+(?:\.\d+){1,3}\b` — здесь `\b` вокруг **цифр** работает корректно (ASCII), так что маскировка версий/URL не ломается; проблема `\b` касается только букв.

---

## 4. Столпы B–D: исследования и инструменты

### 4.1. B. Русская суммаризация/компрессия: данные и модели

**Датасеты.** [`IlyaGusev/gazeta`](https://github.com/IlyaGusev/gazeta) — «Газета: набор данных для автоматического реферирования на русском языке», v1+v2, раздаётся через Dropbox/GitHub Releases/Kaggle/[HF Datasets](https://huggingface.co/datasets/IlyaGusev/gazeta), плюс предобработка под mBART и [`mbart_ru_sum_gazeta`](https://huggingface.co/IlyaGusev/mbart_ru_sum_gazeta) ([README](https://github.com/IlyaGusev/gazeta)). Статья: [arXiv:2006.11063](https://arxiv.org/abs/2006.11063) — «we present Gazeta, the first dataset for summarization of Russian news… we prove the pretrained mBART model to be useful for Russian text summarization». Правовой статус важен для нас: «Usage of this dataset is possible only on a non-commercial basis», права у gazeta.ru ([README, Additional notes](https://github.com/IlyaGusev/gazeta#additional-notes)) → **нельзя** встраивать gazeta-корпус в продакст-плагин как источник правил.

В том же README перечислены русские сплиты мультиязычных корпусов с точными объёмами: XL-Sum — «parsed from www.bbc.com/russian, 77803 samples», MLSUM — 27063 (mk.ru), WikiLingua — 52928 (WikiHow). XL-Sum подтверждает цифру самостоятельно: строка `Russian | ru | bbc.com/russian | Train 62243 / Dev 7780 / Test 7780 / Total 77803` ([README](https://github.com/csebuetnlp/xl-sum#datasets)), и это **abstractive** датасет (название статьи: «XL-Sum: Large-Scale Multilingual **Abstractive** Summarization for 44 Languages»).

**Модели.** [`IlyaGusev/summarus`](https://github.com/ilyagusev/summarus) — «Abstractive **and extractive** summarization models, mostly for Russian language», AllenNLP; extractive-представитель — SummaRuNNer ([arXiv:1611.04230](https://arxiv.org/abs/1611.04230)), abstractive — PGN/CopyNet/mBART ([README](https://github.com/IlyaGusev/summarus#readme)). На Gazeta лучший extractive `gazeta_summarunner_3kk` даёт R-1-f 31.6 / R-L-f 27.1, `gazeta_mbart` 32.6 / 28.2 — то есть **ROUGE ~30, не «сжатие без потери»**.

Семейство русских LLM: [`ai-forever/ru-gpts`](https://github.com/ai-forever/ru-gpts) — «ruGPT3XL, ruGPT3Large, ruGPT3Medium, ruGPT3Small and ruGPT2Large… autoregressive transformer language models trained on a huge dataset of russian language» (ruGPT3XL: 80B токенов, perplexity 12.05) ([README](https://github.com/ai-forever/ru-gpts#readme)). [arXiv:2309.10931](https://arxiv.org/abs/2309.10931) — «A Family of Pretrained Transformer Language Models for Russian», 13 моделей, включая encoder-decoder **ruT5 / FRED-T5** ([модель](https://huggingface.co/ai-forever/FRED-T5-large)); в §4.2 той же статьи они оцениваются на упрощении текста (RuSimpleSentEval-2021) и суммаризации (Gazeta). Релевантная деталь из [README ru-gpts](https://github.com/ai-forever/ru-gpts#papers-mentioning-rugpt3): там прямо перечислены работы по **Text Simplification** с ruGPT-3 — Shatilov & Rey «Sentence simplification with ruGPT3», Fenogenova «Text Simplification with Autoregressive Models», а также решение `Alenush/rugpt3simplification_rsse`.

**Уточнение по RussianSuperGLUE.** В постановке задачи предполагался «Summary task» в RussianSuperGLUE — **его там нет**. Benchmark объявляет «nine tasks, collected and organized analogically to the SuperGLUE methodology» ([README](https://github.com/RussianNLP/RussianSuperGLUE#readme), [russiansuperglue.com](https://russiansuperglue.com/)), и это LiDiRus, RCB, PARus, MuSeRC, TERRa, RUSSE, RWSD, DaNetQA, RuCoS — ни одна не суммаризация. Проверено по странице задач: RuCoS = «Russian reading comprehension with Commonsense reasoning… Binary Classification, F1/EM», где «ответ — текстовый спан из summarizing passage» ([task_info/RuCoS](https://russiansuperglue.com/tasks/task_info/RuCoS)), то есть это QA по CNN/Daily-Mail-подобным новостям, а не компрессия. Статья: [EMNLP 2020, aclanthology.org/2020.emnlp-main.381](https://aclanthology.org/2020.emnlp-main.381/), автор Shavrina et al. → **для нашей задачи RussianSuperGLUE не источник; источник — Kuvshinova (§1, ответ 3) и summarus/gazeta.**

Отдельно: [arXiv:2206.09253](https://arxiv.org/abs/2206.09253) имеет заголовок «Automatic Summarization of Russian Texts: Comparison of Extractive and Abstractive Methods», но прочитанный напрямую абстракт описывает **генерацию аргументативных текстов** (Argumentative Microtext / Persuasive Essays / UKP Sentential, fine-tune RuBERT → разметка экономических новостей → ruGPT-3, 63.2% vs 42.5%). Расхождение заголовка и аннотации; я **не** использую эту работу как доказательство по экстрактивной суммаризации и отмечаю её здесь только как замеченное несоответствие.

### 4.2. C. Мультиязычная prompt-компрессия: русский не тестировался

**LLMLingua** ([arXiv:2310.05736](https://arxiv.org/abs/2310.05736)): «We conduct experiments and analysis over four datasets from different scenarios, i.e., GSM8K, BBH, ShareGPT, and Arxiv-March23… up to 20x compression». Полный текст ([HTML v2](https://arxiv.org/html/2310.05736v2)) не содержит ни одного русского eval-набора; в Appendix A.1 описания датасетов — GSM8K/BBH/ShareGPT/Arxiv — про русский не упоминается; про многоязычность говорит лишь оговорка, что ShareGPT — «users sharing conversations with ChatGPT **in different languages**» ([там же, Appendix A.1](https://arxiv.org/html/2310.05736v2)). В разделе абляции есть baseline «Ours w/ Remove Stop Words, which removes the stop words in original prompts **using NLTK**» — то есть stop-word-подход явно измерен и оказался **худше** энтропийного (стр. 370–373), что полезно как ориентир: наивный стоп-список — нижняя граница качества, а не решение.

**LLMLingua-2** ([arXiv:2403.12968](https://arxiv.org/abs/2403.12968)): «we formulate prompt compression as a token classification problem to guarantee the faithfulness of the compressed prompt to the original one… use a Transformer encoder… such as XLM-RoBERTa-large and mBERT». Обучение — **только английский MeetingBank**: Appendix J гласит «Despite being trained **solely on the MeetingBank data, which consists of English corpus only**, LLMLingua-2 also outperforms LLMLingua on Chinese benchmarks. We attribute this performance gain to the multilingual capabilities of the xlm-roberta-large or multilingual-BERT compressor acquired from the pre-training phase» ([HTML v2](https://arxiv.org/html/2403.12968v2)). Оценка — MeetingBank, LongBench, ZeroScrolls, GSM8K, BBH; из неанглийского — только китайский LongBench (Table 10, «Out-of-domain evaluation on LongBench Chinese benchmarks»). **Русского нет.**

В [`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) README тоже нет русского упоминания: модели — `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` и `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` ([Quick Start](https://github.com/microsoft/LLMLingua#quick-start)); все примеры/демо англоязычные, единственный «инородный» след — «This demo is based on the alt-gpt project. Special thanks to @Livshitz». То есть заявленная мультиязычность опирается на XLM-R/mBERT в качестве энкодера, а **не** на русские данные или русский eval.

**Свежий аудит прямо говорит, что это ловушка.** [arXiv:2608.26175](https://arxiv.org/abs/2608.26175), «Lost in Compression: A Controlled Cross-Lingual Audit of Extractive Prompt Compressors» (Lukauskas, 2026-07-27) — 10 языков, «EN, PL, FI, ET, LV, LT, UK, ZH (Simplified), AR, HI», «five scripts (Latin, **Cyrillic**, Han, Arabic, Devanagari)», то есть ближайшее кириллическое покрытие — **польский, украинский**, а не русский. Три ключевых результата ([abstract](https://arxiv.org/abs/2608.26175)): (i) «the transfer gap is real… at a 0.33 keep-rate English retains 57-62% of normalized context utilization while Lithuanian retains 10-24% and Chinese essentially none»; (ii) «the gap tracks **compression supervision data, not architecture**. All three English-trained compressors show it, **deterministic methods show no comparable gap**, and the multilingually trained XProvence v1 shows none»; (iii) «A translate-then-compress pipeline matches or beats native compression at roughly half the token cost in three of five tested languages». Итог автора: «Safe compression budgets are much smaller outside English».

Это сильнейший аргумент в заметке: **в независимом контролируемом аудите детерминированные методы не показывают кросс-языкового transfer gap, тогда как English-supervised learned-компрессоры показывают его и он велик.** Наш детерминистичный regex-пак попадает ровно в ту категорию, которая «no comparable gap».

Отметка о происхождении самого стиля: [arXiv:2606.24083](https://arxiv.org/abs/2606.24083) «CAVEWOMAN: How Large Language Models Behave Under Linguistic Input and Output Compression» (Adeyemi, Rossi, Dernoncourt; Adobe Research) измеряет именно caveman-регистр: «Output compression cuts realized cost on most API models (1.4-2.4x per model, up to 3x in the best case)… **Input compression has the opposite effect, a strict lose-lose**: it raises net cost rather than lowering it (~1.15x on the five-benchmark mean)… because models compensate with longer responses even as accuracy collapses» ([abstract](https://arxiv.org/abs/2606.24083), [код/данные](https://github.com/danielle34/cavewoman)). Для этого репо это предупреждение: caveman-движок переписывает **входящий** payload, а не output, и в измерении Adobe input-компрессия проигрывает — см. §5.4.

### 4.3. D. Русские NLP-тулкиты, пригодные как подложка

- [`natasha/natasha`](https://github.com/natasha/natasha) (⭐ 1352, MIT): «solves basic NLP tasks for Russian language: tokenization, sentence segmentation, word embedding, morphology tagging, lemmatization, phrase normalization, syntax parsing, NER tagging, fact extraction»; «Natasha is not a research project, underlying technologies are built for production… Models run on CPU, use Numpy for inference» ([README](https://github.com/natasha/natasha#readme)). Даёт `Doc` с `pos`/`feats`/`lemma` на токен — ровно то, что нужно для «part-of-speech-детектора» филеров.
- [`natasha/razdel`](https://github.com/natasha/razdel) (⭐ 288, MIT): «**Rule-based** token, sentence segmentation for Russian language» — детерминированная токенизация без ML. Честная оговорка автора: «`razdel` rules are optimized for these kinds of texts [news and fiction]. Library may perform worse on other domains like social media, scientific articles, legal documents» ([README, Evaluation](https://github.com/natasha/razdel#evaluation)) — а агентские логи ближе всего к «прочим доменам».
- [`natasha/yargy`](https://github.com/natasha/yargy) (⭐ 336, MIT): «**Rule-based** facts extraction for Russian language. Yargy is similar to Tomita parser», «depends only on Pymorphy2». DSL выглядит как раз тот слой, которого не хватает regex-подходу: `rule(...)`, `gram('Surn')`, `morph_pipeline(['управляющий директор','вице-мэр'])`, `gnc_relation()` (согласование род/число/падеж) ([README](https://github.com/natasha/yargy#readme)). `morph_pipeline` принимает **лемму** и сам раскрывает все формы — это и есть механизм против взрыва словоформ (§5.3).
- [`pymorphy2/pymorphy2`](https://github.com/pymorphy2/pymorphy2) (⭐ 1175, MIT): «Morphological analyzer (POS tagger + inflection engine) for Russian and Ukrainian languages»; словарь — OpenCorpora + LanguageTool, «For Russian pymorphy2 provides state-of-the-arts morphological analysis quality» ([README](https://github.com/pymorphy2/pymorphy2), [arXiv:1503.07283](https://arxiv.org/abs/1503.07283)). Ключевые для нас API: `MorphAnalyzer.parse()` → `normal_form` (лемма), `.tag` (POS/падеж/число/род), `.lexeme` (**все формы лексемы**), `.inflect({'gent'})` (поставить в нужную форму) — см. [руководство](https://github.com/pymorphy2/pymorphy2/blob/master/docs/user/guide.rst): «С помощью атрибута `Parse.lexeme` можно получить лексему слова» и вывод 13 форм для `бутявка`. Стоимость: «Экземпляры класса `MorphAnalyzer` обычно занимают порядка 15Мб оперативной памяти».
  **Обработка `ё`/`е` — уже решена внутри анализатора**, и это готовый ответ на требование из постановки: «в словарях употребление буквы "ё" обязательно… В текстах/словах, которые подаются на вход морфологического анализатора, употребление буквы "ё" необязательно. Например, слово "озера" должно быть разобрано и как "(нет) озера", и как "(глубокие) озёра"», реализовано через поиск по DAWG с параллельным пробой ребра `ё` и **замедляет разбор на 10–40%** ([docs/internals/char-substitutes.rst](https://github.com/pymorphy2/pymorphy2/blob/master/docs/internals/char-substitutes.rst)).
  Актуальное состояние ветки: `pymorphy2` **не поддерживается**, продолжение — [`no-plagiarism/pymorphy3`](https://github.com/no-plagiarism/pymorphy3) (форк, ⭐ 148): «pymorphy3 is the continuation of the **unmaintained** project pymorphy2… officially supports Python 3.9 ~ 3.14» ([README](https://github.com/no-plagiarism/pymorphy3#readme)). Это же подтверждает и ruTS: у неё в опциональном extra стоит «C-расширение `DAWG2` для **pymorphy3**» ([README](https://github.com/SergeyShk/ruTS#установка)).
- [`deeppavlov/DeepPavlov`](https://github.com/deeppavlov/DeepPavlov) (⭐ 7k, Apache-2.0): «DeepPavlov 1.0 is an open-source NLP framework built on PyTorch and transformers… created for modular and configuration-driven development of state-of-the-art NLP models… designed for practitioners with limited knowledge of NLP/ML»; платформы Linux/Win10+ (WSL)/macOS Big Sur+, Python 3.6–3.11, «Depending on the model used, you may need from 4 to 16 GB RAM» ([README](https://github.com/deeppavlov/DeepPavlov#readme)). Его RuBERT — [arXiv:1905.07213](https://arxiv.org/abs/1905.07213) «Adaptation of Deep Bidirectional Multilingual Transformers for Russian Language» (Kuratov, Arkhipov) — это та модель, что использована как бейзлайн в Kuvshinova (§1, ответ 3). Для rule-pack DeepPavlov полезен как источник POS/лемматизации, но 4–16 ГБ RAM несовместимы с плагином в агентской сессии → в §5.4 я его отвергаю как рантайм.

**Решающее инфраструктурное ограничение.** Этот репозиторий — TypeScript/Bun (движок [`src/engines/caveman.ts`](../src/engines/caveman.ts), тесты [`test/caveman.test.ts`](../test/caveman.test.ts) на `bun:test`), и в нём **нет Python-рантайма**. Значит pymorphy2/pymorphy3/Natasha/DeepPavlov не могут быть линкованы как зависимость — они годятся только как **офлайн-генераторы данных** (§5.3). Поиск JS-экосистемы морфологии подтверждает тонкость слоя: в npm есть [`mystem3`](https://www.npmjs.com/package/mystem3), но это «a wrapper for… Yandex Mystem 3.0», то есть вызов внешней бинарной проприетарной программы, а не ин-процесс анализатор ([npm](https://www.npmjs.com/package/mystem3)); нативных портов pymorphy на JS/TSA в проверенных источниках я не нашёл (поиск `javascript typescript Russian morphological analyzer lemmatizer npm` дал только Python-обёртки, Go-порт на pymorphy2-словарях ([pkg.go.dev/vbatushev/morph](https://pkg.go.dev/github.com/vbatushev/morph)) и Elixir-порт [`natasha-ex/morph_ru`](https://github.com/natasha-ex/morph_ru) — «Elixir port of pymorphy2»).

---

## 5. Рекомендация: русский rule-pack для `caveman`

### 5.1. Что портируется 1:1 (классы правил из существующих источников)

Ниже — не выдуманные категории, а пересечение трёх независимых носителей: апстрим-`ru` пака, `stop-words.md` (infostyle-skill) и `ruts.constants`. Формат `[правило из RULES]` → русский эквивалент.

| Класс (движок) | Русский | minIntensity | Источник списка |
|---|---|---|---|
| `redundant_openers` | `^Привет\|Здравствуйте\|Добрый день\|Доброе утро\|Добрый вечер[,.!?\s]*` | lite | апстрим `filler/redundant_openers` |
| `pleasantries` | `спасибо`, `заранее благодарю`, `большое/огромное спасибо`, `очень признателен`, `с радостью`, `рад помочь` | lite | апстрим `excessive_gratitude`/`pleasantries` |
| `filler_phrases` (self-reference) | `^(?:Я\|Мы\|Вы)\s+(?:можем\|должны\|будем\|хотим\|нужно)`, `давайте разберём/посмотрим`, `попробуем разобраться`, `постараюсь помочь` | lite/full | апстрим `subject_omission`/`verbal_wrapping`; infostyle кат. 11 «избыточные местоимения» |
| `verbose_connectors` → `также` | `кроме того`, `более того`, `помимо этого`, `в дополнение к этому`, `также` | lite | ruTS `PARENTHETICALS` (`кроме того`), апстрим; `CONNECTOR_CLASSES` |
| `emphasis_removal` | `очень`, `крайне`, `весьма`, `чрезвычайно`, `максимально`, `предельно`, `невероятно` | lite | infostyle кат. 2 «Усилители»; апстрим `empty_qualifiers` |
| `qualifier_removal` | `немного`, `немножко`, `чуть-чуть`, `слегка`, `несколько`, `как-то`, `как бы`, `типа` | lite | апстрим `softeners`; infostyle |
| `hedging` (отсутствует в англ. движке) | `возможно`, `наверное`, `может быть`, `скорее всего`, `вероятно`, `видимо`, `похоже` | lite/full | апстрим `hedging`; infostyle кат. 9 «Неопределённость» |
| `purpose_phrases` | `для того чтобы` → `чтобы`; `с целью того чтобы` → `чтобы` | lite | апстрим `structural/purpose_phrases` |
| `redundant_phrasing` | `в связи с тем, что` / `ввиду того, что` → `из-за`; `несмотря на то, что` → `хотя`; `проблема заключается в том, что` → `проблема:` | full | апстрим `causality_phrases`/`concession_phrases`/`problem_phrasing`; аналог `due to the fact that` → `because` |
| `канцелярит` (отсутствует в англ. движке) | `данный` → (удалить/`этот`), `является`/`представляет собой` → (копула-нуль), `осуществляет` → глагол, `в рамках` → `в/на` | full | ruTS `OFFICIALESE_CLICHES` (89), `COMPOUND_PREPOSITIONS` (48), `LIGHT_VERBS`; infostyle кат. 8/10 |
| `time parasites` (отсутствует) | `в настоящее время`, `на сегодняшний день`, `в данный момент`, `на данный момент`, `в скором времени` | full | ruTS `OFFICIALESE_CLICHES`; infostyle кат. 4 «Паразиты времени» |
| `тавтология/плеоназм` (отсутствует) | пары: `спускаться вниз`, `подниматься вверх`, `прогноз на будущее`, `главный суть` | full | LanguageTool `ru/grammar.xml`, `<short>Тавтология</short>` (50 правил), `Языковая избыточность (плеоназм)` |

Отдельно **добавить класс, которого нет в английской таблице**: вводные конструкции, обрамлённые парой запятых (`PARENTHETICALS`, 36 единиц) — в русском это самый частотный и самый безопасный тип удаления, и он же самый опасный для пунктуации (§5.2, п. 2).

И **не брать** из апстрим-`ru`: `forbidden_abbreviations_dots` (`см.`, `т.е.` — сигнальные), `ultra_punctuation` (ломает `Файл:`), `ultra_compression_*` с литеральным `—` (не даёт savings, а даёт риск), `empty_qualifiers`/`необъективные оценки` (хороший/удобный) — их оценщик должен **заменять конкретикой** (инфостиль: «Никогда не оставляй пустоту», «замени фактами»), а не удалять; детерминистичная правка такой замены не сделает → это `full`-уровень с пропуском, либо вообще вне скоупа.

### 5.2. Три технических требования, специфичные для русского

**1. Граница слова: забыть про `\b` для букв.** Использовать lookaround по Unicode-классу и флаг `u`:

```
/(?<!\p{L})(?:конечно|безусловно)(?!\p{L})/gu        ✅ работает (проверено)
/\b(?:конечно|безусловно)\b/gi                        ❌ 0 совпадений (проверено)
```

Это же чинит и `recapitalizeSentences()`: `/(^|[.!?]\s+)(\p{Ll})/gu` вместо `([a-z])` **[эксперимент: даёт «Очень важно. Как бы. Далее.»]**.

Осторожно с `gi`+`u` и `ё`: **`ё` и `е` — разные символы, и флаг `i` их не уравнивает.** Замерено **[эксперимент]**: на входе `еще всех её всё равно ещё` правило `(?<!\p{L})(?:еще)(?!\p{L})/giu` матчует только `еще` (результат `X всех её всё равно ещё`), а `(?<!\p{L})(?:ещё)(?!\p{L})/giu` — только `ещё` (`еще всех её всё равно X`); то есть **написание в правиле обязано совпасть с написанием в тексте, иначе правило молчит**. Рабочий вариант — класс `[её]` внутри каждого потенциально-`ё`-слова: `(?<!\p{L})(?:ещ[её])(?!\p{L})/giu` матчует оба (`X всех её всё равно X`), а готовый alternation-пак `(?:ещ[её]|е[её]|вс[её]|как[\- ]бы)` на `Её файл, как бы, ещё всё равно, еще раз.` даёт `X файл, X, X X равно, X раз.` — обе орфографии сняты за один проход. Второй вариант — нормализация `ё→е` **только для матчинга** с сохранением оригинала в output; но он дороже, потому что движок не имеет права переписывать орфографию: контракт «код/команды/пути/точные ошибки byte-exact» ([`extractProtected()`](../src/engines/caveman.ts)) распространяется и на текст вокруг них.

**2. Поглощать парную пунктуацию, иначе остаются висячие запятые.** Русский вводный член — это `,СЛОВО,`; паттерн обязан снимать **оба** обрамления: `[ ,]*(?<!\p{L})(?:…)(?!\p{L})[ ,]*`. Вариант «слово + хвост» даёт `Это, займёт время.` **[эксперимент]** — то есть формально сжал, фактически испортил. После удаления нужен cleanup, аналогичный существующему [`cleanupArtifacts()`](../src/engines/caveman.ts) (`/\s+([,.;:!?])/g`), но с добавлением сворачивания `,\s*,` → `,` и отбрасывания пустых скобок/кавычек, потому что `«…»` и `(…)` в русском активны.

**3. Идемпотентность обязательна.** Каждый паттерн после применения не должен оставлять матча (тот же тест twice === once пройден **[эксперимент]**); иначе нарушается требование апстрима «Keep rules idempotent» и ломается липкость решения о сжатии, описанная в этом репо как инвариант (см. [`src/config.ts`](../src/config.ts): интерактивный пресет — «lossless + deterministic stages only — every rewrite must amortize its prompt-cache invalidation», и [чеклист §10, п. 2 соседней заметки](research-semantic-compression.md): «Решение „как сжать блок“ кэшировать по хэшу блока… Недетерминированный judge-гейт… превращает каждый ход в полный cache write»).

### 5.3. Флексии: почему regex-взрывается и какой дешёвый выход

Русский склоняется, поэтому перечисление словоформ в `pattern` не масштабируется: одна лексема типа `потребовать` даёт десятки форм, а LanguageTool решает это не списком форм, а `inflected="yes"` (330 употреблений в `ru/grammar.xml`) и `postag=` (1853) **[эксперимент]**; pymorphy2 демонстрирует масштаб — 13 форм у выдуманного `бутявка` через `Parse.lexeme` ([guide](https://github.com/pymorphy2/pymorphy2/blob/master/docs/user/guide.rst)).

Связка «Python-анализатор недоступен в рантайме TS» + «нужны формы» даёт единственную практичную схему — **офлайн-экспансия, инлайн-в-пак**:

1. В отдельном скрипте (не в плагине) взять `pymorphy3.MorphAnalyzer()` (или `yargy.morph_pipeline`, который делает то же, но уже как rule-примитив) и для каждой леммы из `PARENTHETICALS`/`COMPOUND_PREPOSITIONS`/`OFFICIALESE_CLICHES`/`LIGHT_VERBS` получить все формы и `POS`.
2. Сгенерировать `src/engines/rules/ru-*.json` — тот же формат, что у апстрима (`pattern`/`replacement`/`flags`/`minIntensity`/`name`), но с формами, **уже развёрнутыми** внутри `(?<!\p{L})(?:форма1|форма2|…)(?!\p{L})`. Рантайм остаётся чистым regex: без морфологии, без модели, без RAM, полностью детерминистично.
3. Морфологию использовать и как **фильтр безопасности**: правило «удалить слово X» выпускать только если `POS` совпадает с ожидаемой частью речи (вводное слово = `ADV`/`PRTW`, а не омонимичное существительное), иначе получим ложные удаления. Именно этот механизм есть у `ruTS` — «стоп-слова для водности определяются **по части речи** с помощью pymorphy3» ([дока](https://sergeyshk.github.io/ruTS/stats/style_stats/)).
4. Ё/е берём у анализатора «бесплатно»: pymorphy2 сам разбирает и `озера`, и `озёра` и делает это через DAWG-подмену с замедлением 10–40% ([char-substitutes](https://github.com/pymorphy2/pymorphy2/blob/master/docs/internals/char-substitutes.rst)) — то есть офлайн-экспансия одним прогоном закрывает обе орфографии, и в рантайме `[её]`-классы не нужны.

Объём словаря: `PARENTHETICALS` 36 × ~6 форм ≈ 220 вариантов + `COMPOUND_PREPOSITIONS` 48 × ~5 ≈ 240 + `OFFICIALESE_CLICHES` 89 × ~6 ≈ 530 → порядка 1–1.5 тыс. альтернатив. Это нормально для одного big-alternation regex, но требует **одного прохода по маске** (группировать по `category`, а не по одному правилу), иначе деградация линейна по числу правил. Проверять на целевом узле: движок уже работает по замаскированной строке (`extractProtected`), так что длина строки ограничена.

Если хочется не «формы в regex», а «POS-гейт в рантайме», то минимальный самостоятельный вариант — **словарь вместо анализатора**: зафиксировать `Set<форма>` из `lexeme`-вывода pymorphy3 (по образцу того, как [`vbatushev/morph`](https://pkg.go.dev/github.com/vbatushev/morph) использует «compiled dictionaries from pymorphy2» в Go, и как [`natasha-ex/morph_ru`](https://github.com/natasha-ex/morph_ru) портирует pymorphy2 на OpenCorpora-словаре). То есть: анализатор нужен один раз на сборке словаря, не на каждом сообщении.

### 5.4. Что категорически не брать

1. **LLM-суммаризацию / генеративное упрощение как стадию пайплайна.** Это ломает детерминизм — контракт репо сформулирован явно ([`src/config.ts`](../src/config.ts), комментарий пресета `interactive`), а по независимым данным ещё и обратен цели: [arXiv:2606.24083](https://arxiv.org/abs/2606.24083) измеряет input-компрессию как «strict lose-lose: it raises net cost rather than lowering it… because models compensate with longer responses even as accuracy collapses»; [LLMLingua §Compare with Generation-based Methods](https://arxiv.org/html/2310.05736v2) — «Uncontrollable content leads to low overlap between the generated text and the original prompt». Даже обученный **экстрактивный** ru-компрессор не дотягивает: `RuBert` f1 67.9%, читаемость 3.46/5, и post-hoc синтаксический оценщик вынужден **не сжимать** более половины предложений, чтобы не выдать поломку ([Kuvshinova, Dialogue 2020, Tables 2 и 4](https://dialogue-conf.org/media/5106/kuvshinovat-050.pdf)).
2. **LLMLingua/LLMLingua-2 как «мультиязычное решение для русского».** Supervision только английский, русского eval нет (§4.2), а кросс-язычный аудит прямо фиксирует перенос-гэп у всех трёх English-supervised компрессоров и отсутствие его у детерминированных методов ([arXiv:2608.26175](https://arxiv.org/abs/2608.26175)).
3. **DeepPavlov/Natasha-нейросети как runtime-зависимость плагина.** 4–16 ГБ RAM ([DeepPavlov README, Installation](https://github.com/deeppavlov/DeepPavlov#installation)) и «slovnet_morph_news_v1» модели в пакете natasha противоречат инлайн-хуку в хост-агенте; плюс оговорки о домене — «Models optimized for news articles, quality on other domain may be lower» ([Natasha README](https://github.com/natasha/natasha#readme)) и аналогичная по `razdel` (§4.3).
4. **Заимствование gazeta-корпуса как источника данных.** Некоммерческая лицензия, права у gazeta.ru, «can be removed at the request of the copyright holder» ([README](https://github.com/IlyaGusev/gazeta#additional-notes)).
5. **Главред как бэкэнд.** Правила закрыты, API платный и требует договора с ИП Ильяхов ([glvrd.ru/api](https://glvrd.ru/api/)); кроме того, это lint с human-in-the-loop: «На ваше усмотрение. Главред указывает на слова, без которых текст станет лучше. Следовать его рекомендациям или нет — дело ваше» и «механизмы Главреда несовершенны, поэтому иногда он срабатывает неправильно» ([glvrd.ru/about](https://glvrd.ru/about/)) — интерпретировать «рекомендации» детерминированно нельзя, а автоматическое применение чужих несовершенных подсказок к агентскому payload — тот самый режим, который запрещает чеклист §10 соседней заметки.

### 5.5. Порядок работ (если делать)

1. Починить инфраструктуру, а не правила: `recapitalizeSentences` → `\p{Ll}` + `u`; добавить в `cleanupArtifacts` сворачивание `,\s*,` и очистку пустых `«»`/`()`. Без этого любое русское правило оставляет мусор.
2. Языковой гейт перед фазами правил: сейчас движок **не определяет язык** (в `src/engines/caveman.ts` и [`src/config.ts`](../src/config.ts) нет ни `lang`, ни `detectLang`, ни кириллического класса — **[код]**), поэтому английские правила применяются к русскому входу и жрут смешанный RU/EN текст (§3.1). Прототип детектора можно взять у апстрима: [`languageDetector.ts`](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/open-sse/services/compression/languageDetector.ts) scoring-подход, но **с поправкой**: у него `ru`-хинт тоже обёрнут в `\b`, поэтому реально его ловит только второй паттерн `/[\u0430-\u044f\u0451]/i` **[эксперимент: `detectCompressionLanguage` возвращает `ru` — за счёт кириллического класса, а не ключевых слов]**. Для этого репо достаточно одного `/[\p{Cyrillic}]/u` как выключателя English-правил.
3. Первый релиз — только `lite`-подмножество с доказуемо парной пунктуацией: openers, pleasantries, emphasis, hedging, вводные члены из `PARENTHETICALS`. Без канцелярита и тавтологии (они требуют замены, а не удаления).
4. `full` — `purpose_phrases`/`causality_phrases`/`verbose_connectors` (чистые замены `X → Y`, идемпотентные) и тавтология-пары из LanguageTool.
5. Регрессия по образцу [`test/caveman.test.ts`](../test/caveman.test.ts) (bun:test, `rulesApplied`/`step.output`/`rejectReason`), обязательные кейсы: (i) русская проза сжимается; (ii) смешанный RU/EN — ни одно английское правило не применяется; (iii) после удаления вводного слова нет висячей `,,` и `.,`; (iv) двойной проход идемпотентен; (v) protected spans (`fence`, путь, URL, stack) не тронуты; (vi) `ё` и `е` написания дают одинаковый результат.
6. Отчитываться по savings честно: на реалистичном русском апстрим-пак даёт 5.0–6.6% символов **[эксперимент]**; после `\b`-фикса 9–14 правил из 32 начинают работать, но ориентир по-прежнему скромный — русская агентская проза плотнее английской, и «водность» нормируется как «до 15% — естественное содержание» ([ruTS StyleStats, нормы Text.ru](https://sergeyshk.github.io/ruTS/stats/style_stats/)), то есть **потолок разумного удаления — порядка 15%**, а не 65%.

---

## 6. Итог по вопросу

**«Есть ли аналог caveman для русского языка?»**

- Как **работающий open-source rule-based компрессор прозы** — **нет**. Пустые результаты поиска перечислены в §2.1; единственный «русский caveman» в GitHub — [`krajcik/pi-russian-caveman`](https://github.com/krajcik/pi-russian-caveman), и это system-prompt режим для **другого** агента (`pi`), сжимающий выход модели, а не входящую прозу.
- Как **заготовка в апстрим-системе этого движка** — **да, но сломанная**: [`rules/ru/`](https://github.com/diegosouzapw/OmniRoute/tree/release/v3.8.52/open-sse/services/compression/rules/ru) в OmniRoute v3.8.52 — 32 правила в нужном формате, из которых срабатывают 2 из-за `\b`-vs-кириллица (§3.2), и которые не внесены в `enabledLanguagePacks` (§1, ответ 1). Правка узкая и известная; словарь слов уже есть.
- Как **русский лексикон стоп-слов** — **да, открыто и под MIT**: [`ruts.constants`](https://github.com/SergeyShk/ruTS/blob/master/ruts/constants.py) (`PARENTHETICALS` 36, `COMPOUND_PREPOSITIONS` 48, `OFFICIALESE_CLICHES` 89, `LIGHT_VERBS` 51, `VERBAL_NOUN_SUFFIXES` 6, пары «расщеплённое сказуемое» в `SPLIT_PREDICATE_NOUNS`), типизированный словарь коннекторов из 317 единиц, таксономия 15 категорий в [`infostyle-skill/references/stop-words.md`](https://github.com/artgas1/infostyle-skill/blob/main/skills/infostyle/references/stop-words.md) и 64 правила избыточности/плеоназмов/тавтологий/паразитов в [`LanguageTool ru/grammar.xml`](https://github.com/languagetool-org/languagetool/blob/master/languagetool-language-modules/ru/src/main/resources/org/languagetool/rules/ru/grammar.xml) **[эксперимент, §2.2]**.
- Как **исследовательская задача** — **да**: deletion-based sentence compression для русского формализована и имеет датасет и бейзлайны ([Kuvshinova, Dialogue 2020](https://dialogue-conf.org/media/5106/kuvshinovat-050.pdf)); модели и корпуса — [`gazeta`](https://github.com/IlyaGusev/gazeta) / [`summarus`](https://github.com/IlyaGusev/summarus) / [XL-Sum ru 77 803](https://github.com/csebuetnlp/xl-sum#datasets) / [`ru-gpts`](https://github.com/ai-forever/ru-gpts) / [FRED-T5, arXiv:2309.10931](https://arxiv.org/abs/2309.10931). Но в RussianSuperGLUE суммаризационной задачи **нет** (§4.1), и ни один из этих путей не даёт детерминистичной правки.
- **Рекомендация:** строить русский пакет как `lite`-first regex-пак на базе апстрим-`ru` + `ruts.constants`, с Unicode-lookaround вместо `\b`, с поглощением парной пунктуации, с офлайн-экспансией флексий через pymorphy3-словарь (не через анализатор в рантайме), и **не** брать LLM-суммаризацию ни в каком виде — она ломает детерминизм, на котором держится весь плагин.

---

## Источники (все прочитаны напрямую)

| Источник | URL |
|---|---|
| JuliusBrussee/caveman — upstream skill (Apache-2.0/MIT, output-режим) | https://github.com/JuliusBrussee/caveman |
| krajcik/pi-russian-caveman — README и `extensions/caveman.ts` | https://github.com/krajcik/pi-russian-caveman |
| OmniRoute — `rules/ru/{filler,context,structural,ultra,dedup}.json` | https://github.com/diegosouzapw/OmniRoute/tree/release/v3.8.52/open-sse/services/compression/rules/ru |
| OmniRoute — COMPRESSION_RULES_FORMAT.md (формат паков, Safety Rules) | https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/compression/COMPRESSION_RULES_FORMAT.md |
| OmniRoute — COMPRESSION_LANGUAGE_PACKS.md (список включённых паков) | https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/compression/COMPRESSION_LANGUAGE_PACKS.md |
| OmniRoute — `languageDetector.ts` | https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/open-sse/services/compression/languageDetector.ts |
| LLMLingua (EMNLP 2023) | https://arxiv.org/abs/2310.05736 |
| LLMLingua-2 (ACL 2024 Findings) + HTML v2 (Appendix J) | https://arxiv.org/abs/2403.12968 · https://arxiv.org/html/2403.12968v2 |
| microsoft/LLMLingua — README | https://github.com/microsoft/LLMLingua |
| Lost in Compression — кросс-язычный аудит экстракторов | https://arxiv.org/abs/2608.26175 |
| CAVEWOMAN — измерение input/output-компрессии | https://arxiv.org/abs/2606.24083 · https://github.com/danielle34/cavewoman |
| Kuvshinova — Sentence compression for Russian: dataset and baselines (Dialogue 2020) | https://dialogue-conf.org/media/5106/kuvshinovat-050.pdf |
| Gazeta (датасет) + статья | https://github.com/IlyaGusev/gazeta · https://arxiv.org/abs/2006.11063 |
| Summarus (extractive + abstractive, ru) | https://github.com/IlyaGusev/summarus |
| XL-Sum (44 языка, ru 77 803) | https://github.com/csebuetnlp/xl-sum |
| ai-forever — ru-gpts; FRED-T5 family; модель | https://github.com/ai-forever/ru-gpts · https://arxiv.org/abs/2309.10931 · https://huggingface.co/ai-forever/FRED-T5-large |
| RussianSuperGLUE — README, сайт, страница RuCoS, статья | https://github.com/RussianNLP/RussianSuperGLUE · https://russiansuperglue.com/ · https://russiansuperglue.com/tasks/task_info/RuCoS |
| arXiv 2206.09253 (замеченное расхождение заголовка и аннотации) | https://arxiv.org/abs/2206.09253 |
| Natasha (README) | https://github.com/natasha/natasha |
| razdel — rule-based токенизация (README) | https://github.com/natasha/razdel |
| yargy — rule-based fact extraction (README) | https://github.com/natasha/yargy |
| pymorphy2 — README, user guide, internals/char-substitutes (Ё), статья | https://github.com/pymorphy2/pymorphy2 · https://github.com/pymorphy2/pymorphy2/blob/master/docs/user/guide.rst · https://github.com/pymorphy2/pymorphy2/blob/master/docs/internals/char-substitutes.rst · https://arxiv.org/abs/1503.07283 |
| pymorphy3 — актуальный мейнтейнер | https://github.com/no-plagiarism/pymorphy3 |
| DeepPavlov — README; RuBERT (arXiv:1905.07213) | https://github.com/deeppavlov/DeepPavlov · https://arxiv.org/abs/1905.07213 |
| ruTS — README, StyleStats, constants.py | https://github.com/SergeyShk/ruTS · https://sergeyshk.github.io/ruTS/stats/style_stats/ · https://github.com/SergeyShk/ruTS/blob/master/ruts/constants.py |
| Главред — о проекте; API | https://glvrd.ru/about/ · https://glvrd.ru/api/ |
| LanguageTool — README; правила `ru/grammar.xml`; счётчик правил по языкам | https://github.com/languagetool-org/languagetool · https://github.com/languagetool-org/languagetool/blob/master/languagetool-language-modules/ru/src/main/resources/org/languagetool/rules/ru/grammar.xml · https://dev.languagetool.org/languages |
| genshijin (JA caveman) / troglodita (PT-BR) / caveman-cn / infostyle-skill | https://github.com/InterfaceX-co-jp/genshijin · https://github.com/leninejunior/troglodita · https://github.com/bbylw/caveman-cn · https://github.com/artgas1/infostyle-skill |
| npm mystem3 (обёртка над Yandex Mystem, не ин-процесс) | https://www.npmjs.com/package/mystem3 |
| Внутренние: движок, тесты, контракт детерминизма, соседняя заметка | [`src/engines/caveman.ts`](../src/engines/caveman.ts) · [`test/caveman.test.ts`](../test/caveman.test.ts) · [`src/config.ts`](../src/config.ts) · [`docs/research-semantic-compression.md`](research-semantic-compression.md) |

**Воспроизводимость замеров [эксперимент].** Все опыты выполнены в этом окружении на Node 22.12.0; скрипты лежали во временной директории и в репозиторий не коммитились (по требованию задания изменён только этот файл). Что и где считалось: §2.2 — `grammar.xml` LanguageTool и `ruts/constants.py` разобраны поэлементно (парсер XML-разметки + `ast`), оттуда счётчики `<rule>`/`<short>`/`inflected="yes"` и размеры констант; §3.1 — правила `RULES` из [`src/engines/caveman.ts`](../src/engines/caveman.ts) скопированы дословно и прогнаны на русских и смешанных входах; §3.2 — загружены `rules/ru/*.json` и `languageDetector.ts` из OmniRoute `release/v3.8.52`, по каждому правилу проверено `test`/`replace` на двух русских текстах, плюс отдельный тест природы `\b` (`"К".match(/\w/) === null`); §3.3 и §5.2 — замеры `recapitalizeSentences` с `[a-z]` против `\p{Ll}`, поведения гейта `HAS_SPECIAL_CHARS_RE`/`PROTECTED_STRUCTURE_RE` после маскирования и идемпотентности конвейера; §5.5 — прогон `detectCompressionLanguage` на четырёх входах. Ключевые числа: «FIRED 2/32», «5,0–6,6% экономии», «~9–14 правил оживают после замены `\b`» выводятся из этих скриптов напрямую.
