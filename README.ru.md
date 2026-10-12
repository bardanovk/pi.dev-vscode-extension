<div align="center">

<img src="media/logo-pi-dev.svg" width="220" alt="pi.dev для VS Code" />

# pi.dev — расширение для VS Code

**[Кодинг-агент pi](https://github.com/earendil-works/pi), встроенный в нативную чат-панель VS Code**

Запускается как `pi --mode rpc` в отдельном процессе и управляется по JSONL-протоколу — терминал не нужен.

English · **[Русская версия](README.ru.md)**

</div>

---

## ✨ Возможности

- 💬 **Чат-панель** в activity bar (иконка π) со стримингом токенов в реальном времени
- 🧠 Сворачиваемые **блоки размышлений** (thinking) и **чипы вызовов инструментов** с аргументами и результатами
- ⌨️ `Enter` — отправка, `Shift+Enter` — новая строка; сообщения, написанные во время выполнения, **ставятся в очередь** (follow-up)
- ⏹️ **Стоп** (сброс очереди + abort), **Новая сессия** и **выбор модели** (QuickPick поверх `get_available_models`)
- 📝 Рендеринг Markdown: код-блоки, списки, заголовки, ссылки (открываются через `vscode.env.openExternal`)
- 📊 Метаданные под каждым ответом: модель · токены · стоимость
- 🔒 Усиленная безопасность webview: строгий CSP с nonce, экранирование HTML в выводе модели, RPC-фрейминг строго по LF

## 🏗️ Как это работает

```
┌─────────────────────── Extension Development Host ───────────────────────┐
│                                                                          │
│  ┌── Webview (чат UI) ──┐    postMessage     ┌── extension.ts ────────┐ │
│  │ src/webview/main.ts   │ ◄────────────────► │  команды · состояние ·│ │
│  │  реконструкция событий│                    │  провайдер webview    │ │
│  │  рендеринг markdown   │                    │         │              │ │
│  └───────────────────────┘                    │         ▼              │ │
│                                               │  ┌── piRpc.ts ──────┐  │ │
│                                               │  │ JSONL через stdio│  │ │
│                                               │  └────────┬─────────┘  │ │
└────────────────────────────────────────────────┼──────────┼─────────────┘
                                                  ▼
                                       pi --mode rpc --no-session
                                        (cwd = корень workspace)
```

Webview никогда не обращается к агенту напрямую: он восстанавливает диалог
из сессионных событий RPC (`message_start`, `message_update`, `message_end`,
`tool_execution_*`, `agent_settled`) в точности так, как они определены в
[документации pi RPC](https://github.com/earendil-works/pi).

## ⚙️ Настройки

| Настройка | По умолчанию | Описание |
|---|---|---|
| `pi.executablePath` | `pi` | Путь к CLI pi (фолбэк на `~/.pi/agent/bin/pi`, если нет в `PATH`) |
| `pi.persistSessions` | `false` | Хранить сессии на диске (запускать pi без `--no-session`) |

## 🧰 Команды

| Команда | Название |
|---|---|
| `piAgent.focus` | Pi: Open Pi Chat |
| `piAgent.newSession` | Pi: New Session |
| `piAgent.stop` | Pi: Stop current run |
| `piAgent.selectModel` | Pi: Select Model |

## 📦 Установка

### Из исходников

```bash
git clone git@github.com:bardanovk/pi.dev-vscode-extension.git
cd pi.dev-vscode-extension
npm install
npm run compile
```

Откройте папку в VS Code и нажмите **F5** — запустится Extension Development Host
с иконкой π в activity bar.

### Сборка .vsix

```bash
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension pi-vscode-0.1.0.vsix
```

## 🛠️ Разработка

```bash
npm run compile    # esbuild-бандл (extension + webview)
npm run watch      # пересборка при изменениях
npm run typecheck  # tsc --noEmit
```

### Структура проекта

```
src/
├── extension.ts        # активация, провайдер webview, команды, обвязка RPC
├── piRpc.ts            # RPC-клиент субпроцесса (LF-фрейминг, корреляция по id)
└── webview/main.ts     # чат-UI: реконструкция стриминга + рендеринг
media/                  # иконки и логотипы
```

### Заметки о протоколе

- **Фрейминг**: один JSON-объект на строку, завершённую LF. `readline` не используется —
  он также разбивает по U+2028/U+2029, которые допустимы внутри JSON-строк.
- **Простой**: `agent_end` ≠ простой. Ретраи, восстановление после компакции и
  отложенные follow-up могут запустить новый run; истинный простой — только `agent_settled`.
- **Промпты во время стриминга**: пока идёт run, промпты должны содержать
  `streamingBehavior: "followUp"` (повторяет поведение очереди в TUI).
- **Авторитетный контент**: стриминговые дельты заменяются полезной нагрузкой из
  `message_end`; результаты инструментов приходят сообщениями с ролью `toolResult`
  с ключом `toolCallId`.

## 📄 Лицензия

[MIT](LICENSE)

## 🤖 Происхождение кода

Весь код в этом репозитории сгенерирован с помощью **[pi](https://github.com/earendil-works/pi) 1.1.0** на модели **GLM-5.3**.
