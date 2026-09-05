# OpenCode TUI以外で取れるイベント調査報告 (session.idle 代替案)

## 結論 (3行)

- `session.idle` は TUI 専用 (`packages/opencode/src/session/idle.ts` `idleAfterMs=60000` `bus.publish` 経由、 `opencode serve/run` では発火しない) のため、手動 TUI 75秒待機は自動テストに不向き
- TUI なしで確実に発火するのは `session.created/updated/deleted`, `message.updated/removed`, `message.part.updated/removed`, `session.status/error`, `file.edited/watcher.updated` と Plugin Hooks `tool.execute.before/after`, `command.execute.before`, `chat.message/params` の 10+ 種
- 推奨代替は **① `command.execute.before` で `/logbook` スラッシュコマンド (REI 高, 手動だが TUI 待ち不要)** と **② `session.created` + debounce で自動生成 (被らないよう daily-limit ガード)**、次点で **③ 外部 cron + `Bun.write` (TUI 完全不要)**

## 調査目的

手動 TUI で 75秒 idle を待つ運用がボトルネックになっている。TUI 以外の方法でどのイベントが取れるか、どの Hook が非 TUI でも発火するかを開発者向けに整理し、代替案を提示する。

## 調査方法

- コードベース検索: `grep session.idle`, `grep export type Event`, `grep bus.publish`相当
- 参照: `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (Event 32種), `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (Hooks), `opencode --help` (run/serve は非 TUI)
- 検証: `daily-logbook.ts` の `event` ハンドラを全イベントログに一時変更し `opencode run "hello"` で `/tmp/opencode-events.log` を確認する PoC を試行 (TUI なしでは `session.idle` が飛ばないことを再確認)

## 結果

### 1. SDK Event 32種の一覧と TUI 依存

| Event | TUI 専用? | 発火タイミング | 非 TUI で使えるか |
|-------|-----------|---------------|-------------------|
| `session.idle` | ✅ 専用 | TUI の `idle.ts` のみ。`opencode serve/run` では一切 publish されない | ❌ |
| `tui.prompt.append` | ✅ 専用 | TUI プロンプト入力時 | ❌ |
| `tui.command.execute` | ✅ 専用 | TUI コマンド実行時 | ❌ |
| `tui.toast.show` | ✅ 専用 | TUI トースト表示時 | ❌ |
| `session.created` | 汎用 | `client.session.create` 呼び出し時 (TUI, run, serve, API すべて) | ✅ 推奨 |
| `session.updated` | 汎用 | セッションメタ更新時 | ✅ |
| `session.deleted` | 汎用 | セッション削除時 | ✅ |
| `session.status` | 汎用 | ステータス遷移時 (例: `idle` 以外の状態も含むが `session.idle` とは別) | ✅ |
| `session.error` | 汎用 | LLM エラー時 | △ |
| `session.compacted` | 汎用 | コンパクション時 | △ |
| `message.updated` | 汎用 | メッセージ追加・更新時 (run でも TUI でも) | ✅ |
| `message.removed` | 汎用 | メッセージ削除時 | ✅ |
| `message.part.updated/removed` | 汎用 | パート単位 | ✅ |
| `command.executed` | 汎用 | コマンド実行完了時 | ✅ |
| `file.edited` | 汎用 | ファイル編集ツール実行時 | ✅ |
| `file.watcher.updated` | 汎用 | ファイルシステム変更時 | ✅ |
| `permission.updated/replied` | 汎用 | 権限要求時 | △ |
| `pty.created/updated/exited/deleted` | 汎用 | PTY 生成時 | ✅ (serve でも) |
| `server.connected` | 汎用 | サーバー接続時 | ✅ |
| `lsp.client.diagnostics/updated` | 汎用 | LSP 時 | △ |

**根拠**: `Event = EventServerInstanceDisposed | ... | EventSessionIdle | ... | EventTuiPromptAppend | ...` の 32種のうち `tui.*` と `session.idle` のみが TUI 起点。他は SDK の `client.session.*` / `client.app.*` 経由で publish される。

### 2. Plugin Hooks (event 以外) で非 TUI でも発火するもの

`.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` `Hooks` より:

```ts
export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>; // 上記 32種すべてを受け取れる
  "tool.execute.before"?: (input: { tool, sessionID, callID }, output: { args }) => Promise<void>;
  "tool.execute.after"?: (input: { tool, sessionID, callID, args }, output: { title, output, metadata }) => Promise<void>;
  "command.execute.before"?: (input: { command, sessionID, arguments }, output: { parts }) => Promise<void>;
  "chat.message"?: (input: { sessionID, agent, model }, output: { message, parts }) => Promise<void>;
  "chat.params"?: (input: {}, output: {}) => Promise<void>;
  config?: (input: Config) => Promise<void>;
}
```

- `tool.execute.before/after` — `opencode run` でツール (read, bash, write 等) が呼ばれるたびに発火。非 TUI で最も頻繁
- `command.execute.before` — `/logbook` 等のカスタムコマンド実行時に発火。手動だが idle 待ち不要
- `chat.message` / `chat.params` — LLM 呼び出し前後に発火。run でも発火

いずれも `opencode serve` / `run` で発火するため、代替トリガーになりうる。

### 3. 検証ログ (PoC)

`daily-logbook.ts` の `if (event.type !== "session.idle") return;` を一時的に `appendFileSync("/tmp/opencode-events.log", event.type)` に置換し、`timeout 15 opencode run "hello event test"` を実行。結果:

- `opencode run` では `session.created`, `message.updated` (数回), `session.status` が `/tmp/opencode-events.log` に記録され、`session.idle` は 0 回だった
- `opencode` TUI で 75秒待機した場合は同ログに `session.idle` が 1 回追加された

→ **TUI なしでは `session.idle` 以外のイベントのみが取れる** ことを実測で確認。

## 推奨代替案 (優先度順, REI 評価)

### 🥇 案A: スラッシュコマンド `/logbook` (`command.execute.before`) — 手動だが TUI 待ち不要

**振る舞い**: ユーザが TUI または `opencode run "/logbook"` で `/logbook` を打つ → `command.execute.before` で `Bun.write` 相当の日報生成を実行

**実装**:

```
.opencode/commands/logbook.md  # プロンプト定義 (既存の daily-logbook.ts の buildPrompt を流用)
src/adapters/v1/plugin.v1.ts  # Hooks に "command.execute.before" を追加
  if (input.command === "logbook") { await generateLogbook(sessionID); }
```

**pros**: 非 TUI でも `opencode run "/logbook"` で発火、75秒待ち不要、テストは `opencode run` 1回で完結 (5秒)
**cons**: 自動ではない (手動)
**REI**: 高 (工数 0.5日, 効果 手動テストの苦痛を解消)

### 🥈 案B: `session.created` + debounce 自動生成 — TUI なしの自動化

**振る舞い**: `event.type === "session.created"` を受け取る → `setTimeout 60_000` 後に `isDailyLogbookExists` と `dailyLimitInFlightByDate` ガードを通過すれば生成。連発防止に `recentlyTriggeredAtBySessionId` で debounce (既存の Window ロジックを流用)

**実装**:

```ts
event: async ({ event }) => {
  if (event.type === "session.created" || event.type === "message.updated") {
    // debounce 60s, 既存の isDuplicateTrigger を流用
    if (isDuplicateTrigger(event.properties.info?.id ?? event.properties.sessionID, Date.now(), 60_000)) return;
    // 既存の generateLogbook フローを呼び出し
  }
}
```

**pros**: 完全自動、cron 不要
**cons**: `session.created` はセッション開始直後に飛ぶため、会話がまだ無い段階で日報が空になる可能性。`message.updated` で遅延させる手もあるが、メッセージごとに発火し debounce が必須
**REI**: 中 (工数 1日, 効果 自動化)

### 🥉 案C: 外部 cron + `Bun.write` 直接実行 — TUI 完全不要

**振る舞い**: `cron` (例: `0 0 * * * bun scripts/generate-daily-logbook.ts`) が `sqlite` から当日セッションを集計し `Bun.write("artifacts/daily/YYYYMMDD_logbook.md", ...)` を直接実行。`daily-logbook.ts` の `buildPrompt` / `formatUsageTable` を共通モジュール化して再利用

**実装**:

```
scripts/generate-daily-logbook.ts  # 新規、opencode SDK に依存しない
cron: launchd / systemd / GitHub Actions schedule
```

**pros**: opencode のイベントに一切依存しない、CI でも動く
**cons**: opencode の生成セッション (`client.session.create` + `promptAsync`) を使わないため、日報が LLM 生成でなくテンプレート埋めのみになる (必要なら SDK で `promptAsync` を呼ぶ手もあるが、その場合は再び session が必要)
**REI**: 中〜低 (工数 1.5日, 効果 TUI 依存を完全排除)

## 推奨事項

1. **短期 (今週)**: 案A `/logbook` を実装。手動 TUI テストの苦痛を即解消し、`opencode run "/logbook"` で 5秒で日報を確認できるようにする。既存の `session.idle` は残し、両トリガーを OR で併存させる
2. **中期 (来週)**: 案B `session.created` + debounce を feature flag (`OPENCODE_DAILY_LOGBOOK_TRIGGER=idle|created|both`) で追加。`develop` ブランチで検証
3. **長期**: 案C cron は `daily-limit` ガードと `file-direct` fallback (2.0.9 で追加済み) を活かし、TUI が無い本番 CI でのフォールバックとして検討

いずれの案も `event` Hook 以外の `tool.execute.after` 等は発火頻度が高すぎるため日報トリガーには非推奨。`file.watcher.updated` は無限ループの危険があるため避ける。

## 備考

- `session.idle` 以外で「日報生成に十分な会話が溜まった」ことを保証するイベントは存在しない。`message.updated` は 1 メッセージごとに飛ぶため、必ず debounce / window ガードが必要
- `opencode run` は 1 回の実行で `session.created` → `message.updated` (複数) → `session.status` の順にイベントを流す。`session.idle` は流さないことを PoC で確認済み
- 既存の `isDailyLogbookExists` + `dailyLimitInFlightByDate` + `recentlyTriggeredAtBySessionId` の 3重ガードは案B でもそのまま流用可能
