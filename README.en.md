# my-editor · a lightweight text editor for Windows

[![release](https://img.shields.io/github/v/release/feiYouLian/my-editor?label=release)](https://github.com/feiYouLian/my-editor/releases)
[![license](https://img.shields.io/github/license/feiYouLian/my-editor)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6)
![installer](https://img.shields.io/badge/installer-4.33%20MiB-2ea44f)
![ui](https://img.shields.io/badge/UI-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)

**4.33 MiB installer · 48–53 ms to window · Simplified Chinese UI · nothing to install before you can edit**

> **The UI is Simplified Chinese only.** There is no i18n layer and none is planned, so this page exists only to describe what the project is — not to promise an English interface. The [Chinese README](./README.md) is the authoritative source; this English page is a condensed overview.

## What it is

A desktop text editor built on **Tauri 2 + Vite + TypeScript + CodeMirror 6**. The frontend owns editing and interaction; the Rust side owns file IO, encoding detection, large-file indexing, diffing, formatter dispatching, process running and file watching.

It targets the "look at a 200 MB log / edit a YAML or .properties file / try a Python snippet / capture an API response / write Markdown" kind of work — the things you currently open Notepad++ or a second VS Code window for.

Positioning: **Notepad++-level onboarding cost, far higher capability density than Notepad++.** It is **not** a VS Code replacement: there is no LSP (no go-to-definition, no diagnostics, no semantic completion) and no plugin system, and neither is on the roadmap — see [Trade-offs](#trade-offs).

## Download

| Platform | File | Notes |
| --- | --- | --- |
| Windows x64 | `my-editor_<version>_x64-setup.exe` | NSIS installer, per-user install (**recommended**) |
| Windows x64 | `my-editor_<version>_x64_en-US.msi` | MSI, for managed/batch deployment |

- **Download**: [latest GitHub Release](https://github.com/feiYouLian/my-editor/releases/latest)
- **Mirror / source**: [Gitee](https://gitee.com/feiyoulian/my-editor) · [GitHub](https://github.com/feiYouLian/my-editor)
- Windows only for now. The installer is **not code signed**, so SmartScreen may show an "unknown publisher" warning on first run.

## What you get

| Area | Highlights |
| --- | --- |
| Files & encoding | Atomic save (temp + fsync + rename) that preserves line endings and BOM; three-stage encoding detection (BOM / UTF-8 / chardetng); "reopen as" another encoding; mojibake hints; LF / CRLF / CR switching; external-change prompt with reload / compare / ignore |
| Editor core | CodeMirror 6: multi-cursor, column select, bookmarks, bracket matching, rainbow brackets, code folding, Chinese find & replace with regex capture groups, 17 languages/formats, Minimap |
| Workspace | File tree, quick open (`Ctrl+P`), outline, workspace search & replace with undo history, Git panel (line-level staging, commit, branch switch, ahead/behind), per-file Git status coloring |
| Large files | Files ≥ 20 MB or `*.log` open in a read-only virtual view: sparse line index, windowed reads, filtering, Minimap, encoding reinterpretation |
| Preview & export | Markdown edit/preview/split with scroll sync, sandboxed HTML preview, find-in-preview, export to HTML / Word / PDF, image viewer |
| Formatting | Prettier (lazy per-language) + built-in SQL / XML + CLI channel (black, gofmt, rustfmt, google-java-format, clang-format) |
| Text tools | 8 case/naming styles, JSON ↔ YAML, Properties ↔ YAML, Java → JSON, JSON → Java, regex tester, Cron parser, timestamps / UUID / clipboard image insert, batch "save as encoding" |
| Code Run | `F5` runs Python / Node / Java / cURL with streamed output, colored errors, clickable stack frames; `Ctrl+F5` runs in the built-in PTY terminal |
| Terminal | Real PTY (ConPTY on Windows), PowerShell by default, ANSI colors, `Ctrl+C`, CJK input, single session |
| Settings | Four-page settings center, theme + syntax theme + font size, visual keybinding rebinding with conflict detection, config hot reload, read-only keybinding cheatsheet |

## Measured resources

Sampling method: `.doc/` design docs §11.19. *Lightweight* here means **installer size and startup time only — not memory**.

| Item | Value | Note |
| --- | --- | --- |
| Installer (NSIS / MSI) | **4.33 MiB / 5.88 MiB** | measured on 0.3.2 |
| Bare executable | **12.31 MB** | measured 2026-10-28 |
| App's own process | 25.1 MB working set / **6.0 MB private** | Rust backend + business logic |
| Total private memory | **263–268 MB** | ~262 MB of it is the WebView2 process group (system renderer, cannot be removed) |
| Startup → window visible | 48–53 ms | process creation → main window handle |
| Startup → interactive (TTI) | warm **599–672 ms**, cold first run 866–1088 ms | process creation → first frame painted |

**Read "lightweight" as small installer + fast start, not low memory.** WebView2's fixed cost puts the floor at 160–200 MB regardless of optimisation effort.

## Documentation

| Document | Content |
| --- | --- |
| [docs/USER-GUIDE.md](./docs/USER-GUIDE.md) | User manual (Chinese): 5-minute start, UI tour, common workflows, settings, data locations, troubleshooting order |
| [docs/FAQ.md](./docs/FAQ.md) | Frequent questions (Chinese) |
| [docs/MIGRATION.md](./docs/MIGRATION.md) | What habits to change coming from VS Code / Sublime Text / Notepad++ (Chinese) |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes (Chinese) |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Local build, test baseline, commit & PR conventions (Chinese) |
| Design docs | `轻量级定制文本编辑器_技术设计文档.md`, `编辑器差距补齐_详细设计文档.md`, `终端与CodeRun增强_技术设计文档.md`, and reviews in `.doc/` (Chinese) |

## Trade-offs

**Not implemented, by choice**

- No LSP: no go-to-definition, no type checking, no semantic completion. Renaming a symbol means workspace replace (with undo history).
- No plugin system: 17 languages/formats are built in; you cannot add languages or extensions.
- No AI assistance, no OCR.
- No debugger: `F5` runs the current file, it does not start a debug session.
- No TODO-list view: use workspace search (`Ctrl+Shift+F`) instead.
- Simplified Chinese UI only, no language switch.
- Windows installers only; macOS/Linux are untested, unsigned and unnotarized.
- The built-in terminal is single-session and is not restored with the session.

**Limits**

- Encoding conversion is non-destructive ("save as encoding" produces copies); in-place rewriting goes through workspace replace.
- Format conversion covers JSON ↔ YAML, Properties ↔ YAML, Java → JSON only.
- Web page capture stores the raw HTML only; sub-resources are not downloaded.
- The terminal is an arbitrary-command entry point, not a sandbox; its commands are not subject to Code Run's 30 s / 1 MB caps.
- Diffing skips either side above 4 MB, large-file filtering caps at 50 000 matches, single lines are clamped at 4 000 characters — each of these explains itself and suggests an alternative when triggered.

**Engineering**

- E2E (Playwright + tauri-driver) is not wired up; the substitute is the manual smoke checklist in `验收清单_V1.md`.

## Build from source

```bash
npm install
npm run tauri dev        # dev run
npm run tauri build      # installer in src-tauri/target/release/bundle/
```

Requirements: Node.js ≥ 20, Rust ≥ 1.77, WebView2 Runtime (built into Windows 10/11) and MSVC build tools on Windows. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full acceptance baseline.

## License

MIT — see [LICENSE](./LICENSE).
