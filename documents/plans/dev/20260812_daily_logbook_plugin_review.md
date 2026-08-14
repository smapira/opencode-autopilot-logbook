# デイリーログブックプラグイン開発者ガイド レビュー結果

## レビュー概要

- **計画書**: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`
- **テンプレート**: `plans/dev/daily-logbook.md`
- **元の計画書**: `plans/user/opencode_daily_report_plugin.md`
- **検証日**: 2026-08-12
- **検証方法**: `@opencode-ai/plugin@1.18.15` の型定義（Hooks / PluginInput / SDK gen types）および OpenCode 公式プラグインドキュメントとの照合、既存グローバルプラグイン（`opencode-fi.js`）の実装パターンとの比較

## 結論

**差し戻し（要修正）**。🔴 高優先度の 3 件が実装の前提を崩します。特に「新規セッションに元セッションの履歴が渡らない」問題は設計根幹の缺陷で、このまま実装しても日報の材料が AI に渡らず機能しません。

---

## Issue 1: `session.idle` フックの登録方法が誤り（型エラー・発火しない）

### 優先度
🔴 高

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（Step 2 プラグインコード）
- 関連ファイル: `.github/node_modules/@opencode-ai/plugin/dist/index.d.ts`（`Hooks` 型）

### 指摘事項
計画書のコードは `"session.idle": async (input: SessionIdleInput, ...)` でイベントを購読していますが、これは誤りです。

1. **`Hooks` 型（`@opencode-ai/plugin@1.18.15`）に `"session.idle"` フックは存在しません**。存在するのは `event` / `permission.ask` / `chat.message` / `tool.execute.*` / `experimental.*` 等の固定フックのみ。`"session.idle"` をキーにしたフックはコンパイルエラーになり、実行時にも呼び出されません。
2. **`SessionIdleInput` 型は `@opencode-ai/plugin` / `@opencode-ai/sdk` のどちらにも存在しません**（grep で 0 ヒット）。import の時点でエラーになります。
3. `input.sessionID` も誤り。SDK の `EventSessionIdle` 型では `event.properties.sessionID` が正しいアクセス方法です。

### 改善案
公式ドキュメントのパターンに従い、`event` フックで判定します。

```typescript
return {
  event: async ({ event }) => {
    if (event.type !== "session.idle") return;
    const sessionId = event.properties.sessionID; // 正しいセッションIDの取得方法
    // ... 以下、日報生成処理
  },
};
```

参考（公式ドキュメントの実例）:

```typescript
export const NotificationPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $`osascript -e 'display notification "Session completed!"'`;
      }
    },
  };
};
```

### 備考
既存のグローバルプラグイン `~/.config/opencode/plugins/opencode-fi.js` も `event: async ({ event }) => { if (eventType === "session.idle") ... }` のパターンで実装されており、このプロジェクトの実装慣習でもあります。

---

## Issue 2: `client.session.create({ messages })` は型エラー — プロンプトが送信されない

### 優先度
🔴 高

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（3.2 クライアント API / Step 2 プラグインコード）
- 関連ファイル: `.github/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`（`SessionCreateData`）

### 指摘事項
`client.session.create` のリクエストボディは `{ parentID?: string; title?: string }` のみで、**`messages` プロパティは存在しません**（`SessionCreateData` の型定義で確認済み）。計画書のコードはコンパイルエラーになり、仮に実行されても「タイトルだけの空セッション」が作成されるだけで日報生成プロンプトは送信されません。

正しい API は「セッション作成」と「メッセージ送信」の2段階です。

### 改善案
`session.create` でセッションを作成 → `session.prompt`（または非同期の `promptAsync`）でメッセージを送信します。

```typescript
const session = await client.session.create({
  body: { title: "デイリーログブック自動生成" },
});

await client.session.promptAsync({
  path: { id: session.id },
  body: {
    parts: [{ type: "text", text: prompt }],
  },
});
```

`SessionPromptData.body.parts` は `Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>` です。

### 備考
- `client.app.log` のシグネチャ（`body: { service, level, message }`）は計画書の使い方で正しいことを確認済み。
- 非同期実行にする場合は `promptAsync`（start if needed and return immediately）を推奨します。

---

## Issue 3: 新規セッションには元セッションの履歴が渡らない（設計根幹の缺陷）

### 優先度
🔴 高

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（3.4 テンプレート機能 / SAMPLE_TEMPLATE の文面）
- 関連ファイル: `plans/dev/daily-logbook.md`

### 指摘事項
テンプレートは「セッション {{ sessionId }} の内容を元に、日報を作成してください」と指示しますが、**新規作成したセッションの AI は `{{ sessionId }}` で指された元セッションの会話内容にアクセスできません**。`session.create` は親セッションのコンテキストを引き継ぎません。AI は日報を書くための材料（何をやったか）を一切持たない状態でプロンプトを受けることになり、日報が空振りします。

### 改善案
以下のいずれか（または組み合わせ）に設計を変更してください。

1. **履歴を取得してプロンプトに埋め込む**（確実・推奨）:
   ```typescript
   const messages = await client.session.messages({ path: { id: sessionId } });
   // messages のテキストパートを要約してプロンプトに含める
   const prompt = buildPrompt(sessionId, transcript);
   ```
2. **同一セッションにプロンプトを送る**: 元セッションに対し `session.prompt` で「日報を作成してください」と追加指示を送る（ユーザー操作なしに同一セッションで応答させる）。日報セッションを分離する必要がなければこちらが簡潔。
3. **`parentID` で関連付けてもコンテキストは共有されない**ため、方案 1 か 2 が必須です。

### 備考
- 元の計画書（user 版）は `daily-handover` スキルを呼び出す方式で、スキルが**現在のセッションのコンテキスト**で実行されるため履歴を参照できていました。新方式で「新規セッションにプロンプトを投げる」場合、履歴引き継ぎの仕組みが必須になります。

---

## Issue 4: 日報生成セッションの再発火による多重実行・無限ループリスク

### 優先度
🟡 中

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（3.1 イベント / 9.2 パフォーマンス）

### 指摘事項
`session.idle` は**すべてのセッションで発火**します。プラグインが生成・プロンプト送信した日報セッションも応答完了後に idle になり、ハンドラが再度起動 → また日報セッションを生成…という再帰が発生する可能性があります。また、長時間セッションでは idle のたびに（ユーザー入力のたびに）発火するため、日報生成が多重実行され、LLM コストの無駄になります。

### 改善案
1. **自分が生成したセッションをスキップする**: 生成セッションのタイトルに固定プレフィックス（例: `[daily-logbook]`）を付け、`session.get({ path: { id } })` でタイトルを確認して一致したら return。
2. **スロットリング**: プラグインモジュール変数に「生成済み日付」を持ち、同一日は 1 回だけ実行（日付が変わったらリセット）。
3. 同時実行ガード: `isGenerating` フラグで多重起動を防止（既存 `opencode-fi.js` の `isStarting` パターンが参考）。

### 備考
計画書 9.2 の「`session.idle` イベントは毎回発火するが…セッションの応答に影響しない」という記述は、多重実行のリスクを正しく評価できていません。非同期化だけでなく再発火防止が必要です。

---

## Issue 5: 既存 daily-handover スキルとの重複・二重管理

### 優先度
🟡 中

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（1.1 開発目標 / 2.2 依存関係 / 3.4 テンプレート）
- 関連ファイル: `.github/skills/daily-handover/SKILL.md`, `plans/dev/daily-logbook.md`

### 指摘事項
テンプレート `plans/dev/daily-logbook.md` とツール内 `SAMPLE_TEMPLATE` は、既存 `daily-handover/SKILL.md` の内容（基本方針・日報の内容・仕上げ）とほぼ同一の「独自フォーマット」です。ユーザー版計画書では「既存の daily-handover スキルを活用し、独自フォーマットを定義しない」と明記されていたのが、開発者ガイドでは「依存しない（独自プロンプトで完結）」に変更されています。**SKILL.md が更新されてもテンプレート・SAMPLE_TEMPLATE は追従しない**ため、日報の書き方に関する複数の「正本」が存在し、内容が乖離していくリスクがあります。

### 改善案
- **フォールバックを単一管理にする**: 環境変数未設定時の既定を `plans/dev/daily-logbook.md` の読み込みにし、プラグイン内 `SAMPLE_TEMPLATE` 定数は廃止（ファイル参照に一本化）。
- または、既定テンプレートとして `daily-handover` の SKILL.md を参照する設計にし、テンプレートとの二重管理を回避。
- 少なくとも、SKILL.md とテンプレートのどちらが正本かの方針（ADR）を計画書に明記してください。

### 備考
「日報のみに統一（引き継ぎ文書の生成を削除）」は git ログ（`3156714`）で確認できた意図的な変更ですが、配下の SKILL.md 側は今も「日報と引き継ぎ」両対応のままです。両者の同期方針が未定義です。

---

## Issue 6: 手動コマンドの変数置換の説明が誤り

### 優先度
🟡 中

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（Step 4 コマンドファイル作成）

### 指摘事項
`.opencode/commands/daily-logbook.md` の「テンプレートの {{ sessionId }} にはこのセッションのID、{{ date }} には今日の日付（YYYYMMDD）が置換されます」という記述は誤りです。OpenCode コマンドはマークダウンをそのままプロンプトとして使う仕組みで、`{{ sessionId }}` のような変数置換機能はありません。実際にはリテラル文字列 `{{ sessionId }}` がプロンプトに入り、AI が困惑します。

### 改善案
コマンド文面から変数参照を削除し、シンプルな指示のみにします。

```markdown
---
description: セッションの日報を作成
agent: build
---
このセッションの内容を元に日報を作成してください。

手順:
1. 今日の日付の daily/YYYYMMDD_日報.md を作成（既存があれば追記・更新）
2. 作成したファイル名を報告
```

### 備考
コマンドは現在のセッションのコンテキストで実行されるため（Issue 3 と違い履歴を参照できる）、元の計画書（user 版）の daily-handover 呼び出し方式がそのまま活かせるのはコマンド側だけです。

---

## Issue 7: テスト・デバッグ手順に実在しないコマンド・パス

### 優先度
🟡 中

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（5.3 統合テスト / 6.1, 6.2 トラブルシューティング）

### 指摘事項
以下の記述は実在しないコマンド・パスです。テスト計画・デバッグ手順として機能しません。

- `opencode session --test-mode` — 存在しないオプション
- `~/.opencode/logs/plugin.log` — このパスにプラグインログは出力されない
- `opencode restart` — 存在しないコマンド（プロセスの再起動で代替）

### 改善案
- **テスト計画に TS コンパイルチェックを追加**: `npx tsc --noEmit`（`@opencode-ai/plugin` は projects の `.github/package.json` で管理済み）で型エラーを事前に検出。
- ログ確認は opencode の実際のログ出力先（`~/.local/share/opencode/log/` 等）を確認して記載する。`client.app.log` の出力先は opencode 本体のログに集約されます。
- 自動テストが困難な手動テストに加え、`buildPrompt`（テンプレート解決・変数置換）は純関数として切り出し、単体テスト（node --test 等）で検証可能にすると効果的です。

### 備考
手動テストのシナリオ表（5.1 / 5.2）自体は正常系・異常系が整理されており妥当です。

---

## Issue 8: `.opencode` → `.github` シンボリックリンクの実体の説明不足

### 優先度
🟢 低

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（2.3 ディレクトリ構成）

### 指摘事項
このリポジトリでは `.opencode` は `.github` へのシンボリックリンクです（`opencode.json` / `ls -la` で確認済み）。そのため実ファイルは `.github/plugins/daily-logbook.ts` に置かれることになります。`.github` は GitHub（Actions 等）の予約ディレクトリであり、open コードのプラグインが混在することの意図・影響を計画書で明文化してください。

### 改善案
2.3 節に「`.opencode` は `.github` へのシンボリックリンク。実配置先は `.github/plugins/` となり git 管理される」ことを明記する。`.github/plugins/` が自動ロードされる（Load order 4: project plugin directory）ことも追記すると実装者が迷いません。

### 備考
- プラグイン自動ロードは OpenCode 公式ドキュメント（Load order）で確認済み。`opencode.json` の `plugin` キーへの登録は npm パッケージの指定に使うため、`plugin` キー追加は必須ではありません。
- `.github/.gitignore` に `plugins/` は含まれておらず git 管理対象になることを確認済み（意図通りなら問題なし）。

---

## Issue 9: 日報の保存場所が未定義（既存の運用と分散）

### 優先度
🟢 低

### 対象
- テンプレート: `plans/dev/daily-logbook.md`（`daily/{{ date }}_日報.md`）
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（8.2 ファイル構成）

### 指摘事項
テンプレートは `daily/YYYYMMDD_日報.md` への保存を指示していますが、このリポジトリに `daily/` ディレクトリは存在しません（新設になる）。一方、既存の日報運用は `/Users/bookair18/OS/media/05_claude/daily/`（別リポジトリ）にあり、プラグインが動作するのは本リポジトリのセッションです。保存先が分散し、日報が二重管理になるリスクがあります。

### 改善案
テンプレートの保存先パスを明確に定義してください（例: 本リポジトリの `daily/` に新設する、または絶対パスで既存の管理場所を指定する）。プラグイン起動時に `daily/` がなければ作成する処理も併記すると親切です。

### 備考
日報の命名規則 `YYYYMMDD_日報.md` は既存の Secretary エージェントの規約と整合しており問題ありません。

---

## Issue 10: パス解決コードの細部

### 優先度
🟢 低

### 対象
- 計画書: `plans/dev/opencode_daily_logbook_plugin_developer_guide.md`（Step 2 `buildPrompt`）

### 指摘事項
`resolve(directory ?? "", templatePath)` の `?? ""` は不要です。`PluginInput.directory` は必須（`string`）であり、undefined になりません。また `resolve("", p)` は cwd 基準になるため、意図しないパス解決の原因になります。

### 改善案
```typescript
const resolvedPath = resolve(directory, templatePath);
```

### 備考
テンプレートの参照順（環境変数 → ツール内サンプル）と 3 変数の置換（`{{ sessionId }}` / `{{ date }}` / `{{ dateJp }}`）の設計は明快で妥当です。`replaceAll("{{ date }}", ...)` が `{{ dateJp }}` を誤置換しないことも既存実装の置換順で確認済み（部分文字列としてマッチしない）。

---

## 良かった点（承認時に反映済みとみなす項目）

- テンプレート機能・変数機能の設計（環境変数 `OPENCODE_DAILY_LOGBOOK_TEMPLATE` で差し替え可能）は拡張性があり妥当
- `OPENCODE_DAILY_LOGBOOK_DISABLED` による無効化を最初から設計している
- try/catch でエラーを記録し、セッションを停止させない方針が明記されている
- 実装ファイルが 3 点（プラグイン / テンプレート / コマンド）に整理され、タスク粒度は適切
- 編集範囲はリポジトリ内（`.github/`・`plans/`）に限定されており、コアファイルへの影響なし

## 承認について

🔴 高優先度の Issue 1〜3 が解消され、🟡 中優先度の Issue 4〜7 についても修正方針が反映された計画書の再提出を推奨します。修正後、Implementer への実装依頼を承認して問題ありません。