# Компрессия контекста без потери смыслов: исследовательская заметка

> Расположение: `docs/` — новая директория. В репо не было конвенции для заметок (только `README.md`), поэтому выбрана стандартная `docs/`.
> Вопрос: как организовать работу с компрессией так, чтобы (а) смыслы не ломались и (б) сжатие давало измеримый эффект.
> Все фактические утверждения снабжены ссылками на первоисточники: официальные docs Anthropic/OpenAI, инженерный блог Anthropic, arXiv-абстракты, канонический репозиторий Microsoft LLMLingua. Собственные выводы и арифметика явно помечены как расчёт/синтез.

---

## 1. Резюме: что на самом деле делают вендоры

Пять выводов, которые держатся на первоисточниках:

1. **Лучшая компрессия — та, которая не понадобилась.** Первый ход всех first-party систем — не «сжать», а «не грузить»: just-in-time загрузка по лёгким идентификаторам вместо данных ([Anthropic Engineering, «Context retrieval and agentic search»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)), отложенные MCP-схемы ([Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works)), preprocessing вывода инструментов хуками до попадания в контекст ([Claude Code, «Reduce token usage»](https://code.claude.com/docs/en/costs)).
2. **Безопасная потерянная компрессия — это clearing, а не обрезка.** Anthropic чистит *целые* старые tool-result блоки, заменяя их плейсхолдером, и никогда не режет внутри недавних; сохраняет исходную историю у клиента нетронутой ([Context editing, «Tool result clearing»](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Это ровно та же семья приёмов, что и текущий `smartTruncate` в этом репо (см. §10–11).
3. **Компрессия и prompt caching — конкуренты за один и тот же префикс.** Кэш читается по цене 0.1× от base input; любое изменение префикса инвалидирует кэш от точки изменения и дальше ([Prompt caching, «Pricing»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [Claude Code, «How the cache is organized»](https://code.claude.com/docs/en/prompt-caching)). Сам Anthropic явно дозирует потерянные правки по кэш-экономике через параметр `clear_at_least` ([Context editing, «Context editing and prompt caching»](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
4. **Агрессивная компрессия (LLMLingua) существует, но с жёсткими предохранителями:** экстрактивность вместо генерации (faithfulness по построению), отдельный механизм recovery, сегментные ставки, force-токены ([LLMLingua-2, arXiv:2403.12968](https://arxiv.org/abs/2403.12968); [microsoft/LLMLingua README](https://github.com/microsoft/LLMLingua)).
5. **Компакция (суммаризация) — последняя ступень, а не первая.** И Claude Code, и API-компакция сначала чистят tool outputs, и только потом суммаризуют; недавние ходы сохраняются дословно ([Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works); [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)).

---

## 2. Экономика: кэш против компрессии

### 2.1. Механика prefix-кэша

- Кэш Anthropic пишется на **префикс** запроса — `tools`, `system`, `messages` в этом порядке, до блока с `cache_control`; матчинг точный, «кэша по файлам/сегментам нет» ([Prompt caching, «How prompt caching works»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [Claude Code, «How the cache is organized»](https://code.claude.com/docs/en/prompt-caching)).
- Множители цены: запись в 5-минутный кэш = **1.25×** base input, в 1-часовой = **2×**, чтение (hit/refresh) = **0.1×** base; на новейших моделях чтение ещё дешевле — 0.025×–0.05× ([Prompt caching, «Pricing»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- TTL по умолчанию 5 минут, продлевается бесплатно при каждом использовании; время генерации ответа съедает TTL ([Prompt caching, «How prompt caching works»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- Минимальная кэшируемая длина префикса: **512–4096 токенов в зависимости от модели**; короче — обрабатывается без кэша и без ошибки ([Prompt caching, «Cache limitations»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- У OpenAI та же конструкция: кэш — это KV-состояние неизменного префикса, cached-input rate со скидкой «до 95%», включён по умолчанию ([OpenAI, «Prompt caching»](https://platform.openai.com/docs/guides/prompt-caching)). То есть tradeoff «кэш vs компрессия» не специфика Anthropic.

### 2.2. Арифметика (расчёт по множителям из [Pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))

Пусть стабильный префикс сессии — $N$ токенов, компрессор сжимает его до $rN$.

- **Тёплый append-only цикл без компрессии:** каждый ход платим $0.1 \cdot N$ за переиспользуемый префикс.
- **Однократная липкая компрессия:** в ход правки платим полную запись нового префикса ($\approx 1.25 \cdot rN$), дальше — $0.1 \cdot rN$ за ход. Правка окупается, экономия на каждом последующем ходу.
- **Переписывание префикса каждый ход** (недетерминированный вывод движков, «флапающие» гейты): каждый ход — полная запись, $1.25 \cdot rN$ против $0.1 \cdot N$. Break-even лишь при $r < 0.08$, т.е. требуется стабильное сжатие **лучше ~12×** только чтобы сравняться с простым кэшем. Ни один безопасный для агентской истории режим так не сжимает (референсные цифры LLMLingua — 2×–6× на типовых задачах, 20× — максимум на специальных промптах, [LongLLMLingua, arXiv:2310.06839](https://arxiv.org/abs/2310.06839); [LLMLingua, arXiv:2310.05736](https://arxiv.org/abs/2310.05736)).

Отсюда три правила:

1. **Решения компрессии должны быть детерминированными и липкими** — один блок сжимается один раз и одинаково на всех последующих ходах, иначе сессия превращается в вечный cache miss.
2. **Правки префикса пакетировать и дозировать.** Anthropic формализовал это параметром `clear_at_least`: «если не удаётся очистить хотя бы столько-то токенов — стратегия не применяется; это помогает решить, стоит ли ломать prompt cache» ([Context editing, «Configuration options for tool result clearing»](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
3. **Кэш и компрессия решают разные задачи.** Кэш снижает цену ре-процессинга, но не занимает окно и не лечит context rot («по мере роста числа токенов способность модели точно вспоминать информацию падает», [Anthropic Engineering, «Why context engineering is important»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Компрессия/clearing освобождает окно и префилл-латентность, но платит инвалидацией кэша. В тёплой интерактивной сессии приоритет — стабильность префикса; у лимита окна или на холодном кэше — компрессия.

Подтверждение из first-party практики: `/compact` в Claude Code «по дизайну инвалидирует слой conversation», а тёплый компакт читает префикс из кэша и потому стоит долю от размера контекста; рекомендация — запускать на «естественных паузах между задачами» и «/rewind к уже закэшированному префиксу вместо построения нового», когда путь работы отбрасывается ([Claude Code, «Compacting the conversation», «Rewinding the conversation»](https://code.claude.com/docs/en/prompt-caching)).

---

## 3. Context editing: что Anthropic считает безопасным чистить

Это самый близкий к нашему вопросу официальный артефакт — серверная стратегия `clear_tool_uses_20250919` (beta-хедер `context-management-2025-06-27`) ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)):

**Что чистится и как:**

- Только **tool results**, самые старые, в хронологическом порядке; каждый заменяется **плейсхолдером, сообщающим модели, что результат удалён** — не тихо ([«Tool result clearing»](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
- По умолчанию tool calls (параметры вызовов) **не чистятся** — остаётся видимым, что модель делала (`clear_tool_inputs: false` по умолчанию) ([«Configuration options for tool result clearing»](https://platform.claude.com/docs/en/build-with-claude/context-editing)).

**Knobs (полная таблица):**

| Параметр | Default | Смысл |
|---|---|---|
| `trigger` | 100k input tokens (или в `tool_uses`) | порог активации |
| `keep` | 3 последних tool use/result пары | сколько недавних держать целиком |
| `clear_at_least` | None | минимум токенов за активацию, иначе правка не применяется (амортизация инвалидации кэша) |
| `exclude_tools` | None | инструменты, чьи вызовы/результаты не чистить никогда |
| `clear_tool_inputs` | false | чистить ли параметры вызовов вместе с результатами |

Источник: [«Configuration options for tool result clearing»](https://platform.claude.com/docs/en/build-with-claude/context-editing).

**Ключевые дизайн-принципы, которые стоит перенести:**

1. **Источник истины не разрушается.** Правки применяются серверно к промпту; «клиентское приложение хранит полную, немодифицированную историю — синхронизировать своё состояние с отредактированной версией не нужно» ([«Context editing happens server-side»](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Lossy-компрессия — это *view* поверх сохранённого оригинала, а не перезапись истории на месте.
2. **Правка обязана быть читаемой для модели.** Плейсхолдер «этот результат был удалён» — часть контракта, а не косметика: модель должна знать, чего она не видит.
3. **Инвалидация thinking-блоков.** Клиентские правки ранних ходов инвалидируют thinking-блоки всех последующих ходов; реплей невалидного блока отклоняется (для новых аккаунтов с 2026-08-31) ([«Context editing happens server-side»](https://platform.claude.com/docs/en/build-with-claude/context-editing); [preserved-thinking, «Keeping the prefix unchanged»](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)). Практический вывод: если хост реплеит interleaved thinking, mid-history перезаписи опаснее, чем просто cache miss.
4. **Для большинства случаев Anthropic рекомендует серверную компакцию как основную стратегию, а context editing — как точечный инструмент** ([Context editing, «Overview»](https://platform.claude.com/docs/en/build-with-claude/context-editing); [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)).

---

## 4. Compaction: как устроена потерянная компрессия у Anthropic и Claude Code

- **Порядок эскалации в Claude Code:** «сначала очищаются старые tool outputs, затем при необходимости суммаризуется разговор; запросы пользователя и ключевые куски кода сохраняются» ([Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works)). Тот же порядок зафиксирован в симуляции контекстного окна ([«What survives compaction»](https://code.claude.com/docs/en/context-window)).
- **Что выживает после `/compact`:** system prompt и output style; CLAUDE.md, auto memory, план из plan mode — ре-инъекция с диска; **до 5 недавно изменённых файлов перечитываются** (файл больше 5000 токенов возвращается как path reference `Referenced file` без содержимого); тела вызванных скиллов — с капами 5000 токенов/скилл и 25000 суммарно; фоновые команды продолжают работать с напоминанием модели ([Claude Code, «What survives compaction»](https://code.claude.com/docs/en/context-window)).
- **Порог auto-compact настраивается:** `/autocompact 500k`, флаг `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; дефолты — граница 200K или ~967K на моделях с 1M-окном ([Claude Code, «Set the auto-compact window», «Default auto-compact thresholds»](https://code.claude.com/docs/en/model-config)).
- **Методика тюнинга промпта компакции** — прямой рецепт от Anthropic: «тюньте промпт на сложных агентских трейсах; сначала максимизируйте recall (захватить всё релевантное), затем итеративно повышайте precision (убрать лишнее)»; «одна из самых безопасных, лёгких форм компакции — clearing tool calls and results» ([Anthropic Engineering, «Compaction»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Управляемая потеря:** `/compact focus on the auth bug` и секция `Compact Instructions` в CLAUDE.md задают, что сохранять ([Claude Code, «When your context fills up»](https://code.claude.com/docs/en/how-claude-code-works)); на уровне API — «Compaction that keeps recent turns»: последние ходы дословно, суммарный блок покрывает только старые; свой промпт суммаризации, когда дефолтный «теряет что-то нужное поздним ходам» ([Compaction overview, таблица «Choose how to compact»](https://platform.claude.com/docs/en/build-with-claude/compaction)).
- **Стоп-кран против трэша:** если контекст наполняется немедленно после каждой суммаризации, Claude Code прекращает авто-компакцию после нескольких попыток и показывает ошибку вместо бесконечного цикла ([Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works)).
- **Мембраны вне окна:** structured note-taking (NOTES.md, memory tool, to-do) — персистентная память с минимальным оверхедом, читается обратно при необходимости; sub-agent архитектура: субагент сжигает десятки тысяч токенов, возвращает «конденсированный summary 1000–2000 токенов», а детальный поисковый контекст остаётся изолированным ([Anthropic Engineering, «Structured note-taking», «Sub-agent architectures»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

---

## 5. LLMLingua: агрессивная компрессия и её предохранители

Три статьи Microsoft (все абстракты прочитаны напрямую на arXiv):

**LLMLingua** ([arXiv:2310.05736](https://arxiv.org/abs/2310.05736)) — coarse-to-fine компрессия промптов малой LM (GPT2-small/LLaMA-7B): **budget controller «to maintain semantic integrity under high compression ratios»**, токенно-уровневый итеративный алгоритм (моделирует взаимозависимости сжимаемого), instruction tuning для выравнивания распределений LM-компрессора и целевой LLM. Результат: до **20×** с малой потерей качества (GSM8K, BBH, ShareGPT, Arxiv-March23).

**LongLLMLingua** ([arXiv:2310.06839](https://arxiv.org/abs/2310.06839)) — длинный контекст: три проблемы (цена, деградация качества, **position bias**); «производительность LLM зависит от плотности и позиции ключевой информации во входном промпте». Цифры: NaturalQuestions **+21.4% качества при ~4× меньших токенах** на GPT-3.5-Turbo; LooGLE — **94% снижения стоимости**; 2×–6× на промптах ~10k токенов ускоряют end-to-end латентность в 1.4×–2.6×. Ровно тут же — в README — механика **recovery**: `recover(original_prompt, compressed_prompt, response)` восстанавливает ответ в терминах оригинала, и заявлено «Comprehensive Recovery: GPT-4 can recover all key information from compressed prompts» ([microsoft/LLMLingua, DOCUMENT.md «Post-Processing»](https://github.com/microsoft/LLMLingua/blob/main/DOCUMENT.md); [README, TL;DR](https://github.com/microsoft/LLMLingua)).

**LLMLingua-2** ([arXiv:2403.12968](https://arxiv.org/abs/2403.12968)) — мотивация: информационная энтропия каузальной LM — субоптимальная метрика (односторонний контекст, не выровнена с целью компрессии). Решение: дистилляция из LLM в **экстрактивный** датасет + **token classification** на bidirectional Transformer encoder — «формулируем компрессию промпта как задачу классификации токенов, чтобы **гарантировать верность сжатого промпта оригиналу**». Скорость: компрессор в 3×–6× быстрее существующих, end-to-end латентность 1.6×–2.9× при коэффициентах 2×–5× (MeetingBank, LongBench, ZeroScrolls, GSM8K, BBH).

**Практические предохранители из README/DOCUMENT** ([microsoft/LLMLingua](https://github.com/microsoft/LLMLingua)):

- **Структурная сегментация с пер-секционными ставками:** теги `<llmlingua, compress=False>` / `<llmlingua, rate=0.4>` — какие куски не трогать вовсе, какие и насколько (README, «Advanced usage — Structured Prompt Compression»).
- **`force_tokens = ['\n', '?']`** — структурные токены защищены от удаления (README, Quick Start).
- **`reorder_context="sort"`, `dynamic_context_compression_ratio`, `condition_compare`** — борьба с position bias переупорядочиванием по важности, а не равномерной резкой (README, Quick Start, параметры LongLLMLingua).
- **Recovery как штатный пост-этап**, а не аварийный хак.

> Замечание к ссылкам: правильный arXiv-ID LongLLMLingua — **2310.06839**; ID 2309.12307 принадлежит чужой работе (LongLoRA, fine-tuning длинного контекста) — частая путаница при цитировании.

---

## 6. Синтез: лестница компрессии по безопасности

Лестница упорядочена по риску для смыслов; двигаться вниз только когда верхняя ступень исчерпана.

### Ступень 0 — не грузить (профилактика)
Идентификаторы вместо данных, just-in-time загрузка инструментами; отложенные схемы MCP; preprocessing вывода хуками; reference-контент в скиллах вместо CLAUDE.md ([Anthropic Engineering, «Context retrieval and agentic search»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works); [«Reduce token usage»](https://code.claude.com/docs/en/costs)). Токен, не попавший в контекст, не нужно ни сжимать, ни восстанавливать.

### Ступень 1 — lossless структурная
Дедуп с reference-маркерами (первое вхождение дословно, повторы коллапсируют в ссылку); компактные сериализации/энкодеры (JSON → табличный формат без изменения семантики); hash-выгрузка: оригинал хранится вне полосы, в контексте — маркер с хэшем, восстановление по требованию. Принцип тот же, что у «lightweight identifiers + load on demand» ([Anthropic Engineering, «Context retrieval and agentic search»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) и у серверного контракта «клиент хранит полную историю» ([Context editing, «Context editing happens server-side»](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Верификация: реконструкция байт-в-байт.

### Ступень 2 — кэш вместо компрессии
Когда префикс стабилен, а провайдер поддерживает prefix-кэш: не сжимать, а закэшировать (§2). Условия: стабильный порядок слоёв «редко меняющееся — в начало» ([Claude Code, слойная таблица](https://code.claude.com/docs/en/prompt-caching)), детерминированные payload, осознанный выбор TTL, отказ от пути — truncation к ранее закэшированному префиксу (`/rewind`), а не компакция ([Claude Code, «Rewinding the conversation»](https://code.claude.com/docs/en/prompt-caching)).

### Ступень 3 — semantics-guarded lossy (clearing)
Удалять только доказуемо не-новое или доказуемо мёртвое:

- **Целые старые tool-result блоки, старейшие первыми**, плейсхолдер вместо тихой дыры, K последних — целиком, exclude-list для критичных инструментов ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
- **Внутри блока — только нормализованные повторы и тривиальный filler**, первое вхождение каждой уникальной строки выживает, ERROR/WARN выживают всегда, маркер с числом выкинутых строк — это текущий `smartTruncate` данного репо (`src/engines/truncate.ts`), и он попадает в ту же семью приёмов, что и «discard redundant tool outputs» в компакции Claude Code ([Anthropic Engineering, «Compaction»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- Гейты: LLM-judge на фиделити, числовой порог, rollback при провале; логировать только негативные savings с причиной (паттерн «sending original» при отказе движка — как fallback в этом репо, `src/live/capture.ts`).
- Текущие ходы и новейший user-месседж — никогда (safety contract этого репо; ср. `keep` у Anthropic и «recent turns stay word for word» у компакции, [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)).

### Ступень 4 — агрессивная потерянная
Токен-дроппинг LLMLingua-типа и суммаризация/компакция. Допустимо, когда: холодный кэш (TTL истёк, смена модели — [Claude Code, «Switching models»](https://code.claude.com/docs/en/prompt-caching)), жёсткий лимит окна, доминирует префилл-латентность, или контент заведомо мёртв («compaction works in your favor when the context you discard is content you no longer need», [Claude Code, «Compacting the conversation»](https://code.claude.com/docs/en/prompt-caching)). Обязательные guardrails из источников:

- recall-first тюнинг промпта компакции на реальных сложных трейсах, затем precision ([Anthropic Engineering, «Compaction»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents));
- недавние ходы дословно, свой промпт суммаризации при потерях ([Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction));
- экстрактивность вместо генерации — faithfulness по построению ([LLMLingua-2](https://arxiv.org/abs/2403.12968));
- сегментные ставки + `compress=False` острова + force-токены + переупорядочивание по важности ([microsoft/LLMLingua README](https://github.com/microsoft/LLMLingua));
- recovery-механизм и верификация на downstream-задаче, а не на текстовом сходстве ([LongLLMLingua](https://arxiv.org/abs/2310.06839); [DOCUMENT.md, «Post-Processing»](https://github.com/microsoft/LLMLingua/blob/main/DOCUMENT.md)).

---

## 7. Инвентаризация контекста агента: что чем доминирует и что терпит

| Класс | Чем доминирует в реальном harness | Что терпит | Основание |
|---|---|---|---|
| System prompt + tool definitions | Стабилен; инвалидирует весь кэш при изменении | Только ступень 0 (минимализм, отложенные схемы); не сжимать | [Claude Code, слойная таблица](https://code.claude.com/docs/en/prompt-caching); [«When context fills up»](https://code.claude.com/docs/en/how-claude-code-works) |
| Проектные инструкции (CLAUDE.md-класс) | Ре-инъекция с диска после компакции | Лёгкое сжатие автором (капы, вынос в скиллы); не движком | [«What survives compaction»](https://code.claude.com/docs/en/context-window) |
| История сообщений (решения, анализ) | Держит связность; «ранние инструкции могут теряться» при компакции | Ступени 1–2; потерянно — только через суммаризацию с recall-тюнингом | [Anthropic Engineering, «Compaction»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| Tool outputs (чтения файлов, логи, выдача команд) | **Главный потребитель окна** («File reads dominate context usage») | Лучше всех: дедуп, clearing, маркеры, хэш-выгрузка | [Claude Code, симуляция контекстного окна](https://code.claude.com/docs/en/context-window); [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) |
| Машинный вывод/JSON | Повторы, счётчики, noise-строки | Структурная lossless + нормализованная дедупликация строк | [LLMLingua-2: избыточность естественного языка](https://arxiv.org/abs/2403.12968); практика RTK-фильтров |
| Thinking-блоки | Инвалидируются mid-history правками | Не трогать вообще; только штатные стратегии `clear_thinking` | [Context editing, «Context editing happens server-side»](https://platform.claude.com/docs/en/build-with-claude/context-editing) |
| Изображения/PDF | Отдельные лимиты запроса | Батчевое удаление старейших (один медленный ход на батч) | [Claude Code, «Accumulating many images»](https://code.claude.com/docs/en/prompt-caching) |

---

## 8. Измерение: экономия против фиделити

Две оси, обе обязательны.

**Экономия (по стадиям):**

- Пер-стадийно: `originalTokens`/`compressedTokens`/`rejected`/`rejectReason` — уже делается в debug.jsonl этого репо. Эталон разбора: `/context` в Claude Code — live-разбивка по категориям с советами ([«Check your own session»](https://code.claude.com/docs/en/context-window)).
- **Кэш-ось обязательно инструментировать:** `cache_creation_input_tokens` и `cache_read_input_tokens` из response usage; «если оба нули — промпт не был закэширован (вероятно, не дотянул до минимальной длины)» ([Prompt caching, «Cache limitations / Tracking cache performance»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Чистая экономия правки = сэкономленные токены **минус** удорожание от инвалидации кэша (расчёт §2.2). Anthropic сам считает через `clear_at_least`, а Claude Code честно описывает цену `/compact` как «один медленный дорогой ход» ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing); [Claude Code, «Compacting the conversation»](https://code.claude.com/docs/en/prompt-caching)).

**Фиделити:**

- LLM-judge (A/B сравнение движков — вкладка Compare этого репо); методологический ориентир — «тюньте на сложных агентских трейсах» ([Anthropic Engineering, «Compaction»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- Downstream-задача как окончательная метрика: LongLLMLingua доказывает пользу компрессии именно ростом качества задачи (+21.4% NQ при 4× меньших токенах), а не сходством текстов ([arXiv:2310.06839](https://arxiv.org/abs/2310.06839)).
- Recovery-проверка: может ли модель восстановить ключевые факты из сжатого промпта (штатный `recover()` у LLMLingua, [DOCUMENT.md, «Post-Processing»](https://github.com/microsoft/LLMLingua/blob/main/DOCUMENT.md)).
- Числовые пороги + rollback: гейты с численным критерием и откатом на оригинал при провале; логировать только негативные savings и причины отказов; ротация логов (текущая практика репо — `debug.jsonl`, `src/live/log-rotation.ts`).

### 8.1. Живые прод-данные: локальный OmniRoute-инстанс (источник — телеметрия MCP `compression_status`, 2026-09-30)

Система, с которой портирован этот репо, работает в проде и подтверждает обе оси одновременно:

- **Экономия реальна и значима:** 51 331 запрос через компрессию (strategy lite/stacked), средняя экономия **22%**, суммарно ~**1.95 млрд токенов**, ≈ **$415** сэкономлено по фактическим usage-расценкам провайдеров.
- **Гейты фиделити срабатывают, а не декоративны:** 11 983 validation fallback (~23% запросов) — почти четверть компрессий откатана проверками валидности до отправки. Это прямое прод-подтверждение конструкции «lossy только под численным предохранителем с откатом».
- **Компрессия и prompt-кэш сосуществуют:** 3.14 млрд из 3.93 млрд prompt-токенов (≈80%) пришлись на cache reads. Детерминированные липкие стадии (dedup/RTK-фильтры) не ломают префикс каждый ход — вопреки пессимистичному сценарию §2.2, который актуален только для недетерминированных перезаписей.

[Локальная телеметрия; не публичный источник — цифры валидны для этого инстанса.]

---

## 9. Задокументированные failure modes

1. **Галлюцинации от генеративной компрессии.** Энтропийный дроппинг каузальной LM субоптимален; LLMLingua-2 перешёл к экстрактивной token classification ровно ради «гарантии верности сжатого промпта оригиналу» ([arXiv:2403.12968](https://arxiv.org/abs/2403.12968)). Генеративная суммаризация может добавить то, чего не было; экстрактивная — нет.
2. **Инвалидация кэша от компрессии.** Tool result clearing ломает закэшированные префиксы; лекарство — дозированность (`clear_at_least`) и осознанная оплата cache-write ([Context editing, «Context editing and prompt caching»](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Сжатие ниже минимальной кэшируемой длины (512–4096 по модели) делает префикс принципиально некэшируемым ([Prompt caching, «Cache limitations»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
3. **Слом identity tool-результатов.** Тихое удаление без плейсхолдера ломает картину истории у модели; чистка результатов без чистки вызовов сохраняет парность «вызов → результат» ([Context editing, «Tool result clearing»](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
4. **Position bias / lost-in-the-middle.** Качество зависит от позиции ключевой информации; слепая резка головы или середины — противоположность доказанному («performance hinges on the density and position of key information», [LongLLMLingua](https://arxiv.org/abs/2310.06839)). First-party системы режут целые старейшие блоки, недавние держат целиком.
5. **Потеря «незаметно-критичного» контекста при компакции.** «Чрезмерно агрессивная компакция теряет тонкий, но критичный контекст, важность которого выясняется позже» ([Anthropic Engineering, «Compaction»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) — отсюда recall-first тюнинг.
6. **Трэш-цикл компакции.** Контекст наполняется немедленно после суммаризации → стоп после нескольких попыток с ошибкой ([Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works)). Аналог: одиночный гигантский блок, который нельзя спасти пакетной правкой.
7. **Инвалидация thinking-блоков клиентскими правками.** Mid-history перезапись ломает валидность thinking во всех последующих ходах; реплей отклоняется ([Context editing, «Context editing happens server-side»](https://platform.claude.com/docs/en/build-with-claude/context-editing)).

---

## 10. Чеклист для пайплайнов omp-compress-studio

Проверено против текущего кода репо (`src/engines/*`, `src/live/capture.ts`):

1. **Сохранить safety contracts:** новейший user-месседж и текущий tool-result — всегда дословно. Соответствует `keep` у Anthropic и «recent turns stay word for word» ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing); [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)). Уже реализовано — не регрессировать.
2. **Детерминизм и липкость движков.** Решение «как сжать блок» кэшировать по хэшу блока (сжал один раз — на следующих ходах воспроизводи байт-в-байт). Недетерминированный judge-гейт, меняющий вердикт от хода к ходу, превращает каждый ход в полный cache write (§2.2). Это главный незакрытый пункт текущего дизайна.
3. **Гистерезис в стиле `clear_at_least`.** Переписывать блок в payload только если экономия ≥ порога (например, N токенов или %), иначе оставить нетронутым ради префикса. Прямой аналог: «clear enough tokens to make the cache invalidation worthwhile» ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
4. **Стадия clearing целых старых блоков** как отдельный движок с knobs `trigger`/`keep`/`exclude_tools` — сейчас clearing-семантика размазана по truncate/sessionDedup на уровне строк/блоков-повторов; Anthropic-подобная очистка старых *уникальных* tool-result-ов (с плейсхолдером) — следующий безопасный резерв экономии.
5. **Маркеры читаемы и считаемы** — уже есть (`[… N lines truncated …]`, `dedup-ref-marker`). Развитие: добавить в маркер хэш/путь восстановления (ступень 1, hash-выгрузка), чтобы модель могла запросить оригинал — паттерн just-in-time ([Anthropic Engineering, «Context retrieval and agentic search»](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
6. **Кэш-телеметрия.** В debug-запись и stats widget добавить `cache_creation_input_tokens`/`cache_read_input_tokens` провайдера и считать net-savings с учётом инвалидации ([Prompt caching, «Tracking cache performance»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
7. **Пресеты по сценариям, а не по агрессивности.** `stacked`/`ultra` на тёплой интерактивной сессии конкурируют с кэшем; приберечь тяжёлые дорожки (caveman@ultra, LLMLingua-подобный дроппинг) для холодных payload: сборка system-промпта, большие вставленные документы, one-shot задачи. Ориентир: «compaction works in your favor when the context you discard is content you no longer need» ([Claude Code](https://code.claude.com/docs/en/prompt-caching)).
8. **Не сжимать ниже минимальной кэшируемой длины** модели (512–4096 токенов) и не разбивать кэшируемый префикс ради копеечной экономии ([Prompt caching, «Cache limitations»](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
9. **Thinking-чувствительность:** если модель хоста реплеит interleaved thinking — исключить такие сообщения из правок полностью ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
10. **Judge по семплингу с капом стоимости** (уже есть) + периодический downstream-эвал: воспроизведение ключевых фактов из сжатой сессии (recovery-проверка из [LongLLMLingua](https://arxiv.org/abs/2310.06839)), не только текстовое сходство.
11. **Стоп-кран:** если после полного прохода экономия ≈ 0 или контекст продолжает упираться в лимит — отключать компрессию с явной причиной, как Claude Code останавливает авто-компакцию при трэшинге ([Claude Code, «When context fills up»](https://code.claude.com/docs/en/how-claude-code-works)).
12. **Источник истины не рушить:** компрессия применяется к исходящему payload (`before_provider_request`), история сессии хоста остаётся оригинальной — это правильный «view, а не перезапись» контракт ([Context editing, «Context editing happens server-side»](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Закрепить как инвариант тестом.

---

## 11. Противоречия и подтверждения относительно текущего подхода

**Источники подтверждают:**

- Удаление head-only truncation было верным: ни одна first-party система не режет внутри недавних tool outputs; позиция ключевой информации — доказанный фактор качества ([LongLLMLingua](https://arxiv.org/abs/2310.06839)); Anthropic чистит целые старейшие блоки и держит недавние целиком ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
- Текущий `smartTruncate` (первое вхождение выживает, ERROR/WARN выживает, маркеры с счётчиком, отсечение только нормализованных повторов) — корректная реализация ступени 3: «доказуемо не-новое» + «правка читаема моделью».
- Дедуп с reference-маркерами на уровне сессии (`sessionDedup`) — ступень 1, совпадает по духу с «identifiers + load on demand».
- Safety contracts (newest-user, current-turn) — зеркалируют `keep`-семантику вендора.

**Напряжённости, которые стоит закрыть:**

1. **Перезапись ранних блоков payload каждый ход vs prompt cache.** Сейчас движки применяются ко всем eligible-блокам на каждом `before_provider_request`. Если вывод движка детерминирован — префикс стабильный после первого прохода, цена платится один раз (это соответствует «you'll incur cache write costs each time content is cleared, but subsequent requests can reuse the newly cached prefix», [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Если нет — см. §2.2, экономия уходит в минус. Нужны пункты 2–3 чеклиста (липкость + гистерезис).
2. **Пресет `stacked` по умолчанию** включает truncate+caveman на всех eligible-блоках; для тёплых кэшируемых сессий это не «бесплатная экономия», а обмен cache-hit 0.1× на полный cache-write. Источники рекомендуют дозировать ([clear_at_least](https://platform.claude.com/docs/en/build-with-claude/context-editing); [Claude Code, «Compacting the conversation»](https://code.claude.com/docs/en/prompt-caching)).
3. **Per-block капы (`MAX_LINES`/`MAX_CHARS`) как триггер** — у вендора триггером служит общий порог контекста (`trigger: input_tokens`), а не размер отдельного блока ([Context editing, «Configuration options»](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Это не противоречие (безопасность обеспечивается novelty-guard, а не капом), но кап на уникальном контенте — единственное место, где движок всё ещё может выкинуть неповторяющуюся информацию (пусть и с маркером); вендорного прецедента для резки уникального содержимого внутри блока нет.

---

## Источники (все проверены чтением первоисточника)

| Источник | URL |
|---|---|
| Anthropic — Prompt caching (docs) | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Anthropic — Context editing (docs) | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| Anthropic — Compaction overview (docs) | https://platform.claude.com/docs/en/build-with-claude/compaction |
| Anthropic — Preserved thinking (docs) | https://platform.claude.com/docs/en/build-with-claude/preserved-thinking |
| Anthropic Engineering — Effective context engineering for AI agents (2025-09-29) | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Claude Code — Explore the context window | https://code.claude.com/docs/en/context-window |
| Claude Code — How Claude Code uses prompt caching | https://code.claude.com/docs/en/prompt-caching |
| Claude Code — Model configuration (auto-compact) | https://code.claude.com/docs/en/model-config |
| Claude Code — How Claude Code works | https://code.claude.com/docs/en/how-claude-code-works |
| Claude Code — Manage costs (Reduce token usage) | https://code.claude.com/docs/en/costs |
| LLMLingua (EMNLP 2023) | https://arxiv.org/abs/2310.05736 |
| LongLLMLingua (ACL 2024) | https://arxiv.org/abs/2310.06839 |
| LLMLingua-2 (ACL 2024 Findings) | https://arxiv.org/abs/2403.12968 |
| microsoft/LLMLingua — README и DOCUMENT.md | https://github.com/microsoft/LLMLingua |
| OpenAI — Prompt caching | https://platform.openai.com/docs/guides/prompt-caching |
