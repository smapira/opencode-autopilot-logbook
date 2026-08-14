# opencode-autopilot-logbook プラグイン インストール・アンインストール手順レビュー

## 概要

README.md / README.jp.md のインストール手順と、実際の動作を照合した結果、6件の問題を発見。

## レビュー日

2026-08-14

## レビュー範囲

- README.md（英語）
- README.jp.md（日本語）
- package.json
- daily-logbook.ts
- 実環境でのインストール→アンインストール→再インストール操作

---

## 発見項目

### 🔴 Issue 1: 設定ファイルの二重存在（opencode.json vs opencode.jsonc）

**優先度**: 🔴 高

**問題**:
`opencode plugin opencode-autopilot-logbook -g` を実行すると、プラグイン設定は `opencode.json` に書き込まれる。しかし既存のプラグインリストは `opencode.jsonc` にあり、二つのファイルが別々に存在する。

**発見した事実**:
- `~/.config/opencode/opencode.jsonc`: 6つのプラグインが定義（opencode-handoff 等）
- `~/.config/opencode/opencode.json`: daily-logbook のみ + MCP 設定
- 両ファイルの `plugin` 配列が一致しない

**影響**:
- ユーザーがどの設定ファイルが有効か把握しにくい
- `opencode.jsonc` のプラグインが `opencode.json` に反映されない可能性

**修正案**:
README に以下の注意書きを追加する:

```markdown
> **注意**: `opencode plugin -g` は `~/.config/opencode/opencode.json` に設定を書き込みます。
> もし `opencode.jsonc` を使用している場合は、手動で `opencode.jsonc` の `plugin` 配列に
> `"opencode-autopilot-logbook"` を追加してください。
```

---

### 🔴 Issue 2: package.json のバージョン不一致とビルドスクリプトの参照ミス

**優先度**: 🔴 高

**問題**:
1. `package.json` の `version` は `1.0.8` だが、npm レジストリに公開されているのは `1.0.7` まで
2. `prepublishOnly` スクリプトが `.github/plugins/daily-logbook.ts` を参照するが、このパスにはファイルがない（ソースはルートの `daily-logbook.ts`）
3. `CHANGELOG.md` は `1.0.5` までしか記録がない

**発見した事実**:
- ローカル `package.json`: `"version": "1.0.8"`
- npm レジストリ: 最新版は `1.0.7`
- `.github/plugins/` は空ディレクトリ
- ルートに `daily-logbook.ts` が存在
- `package.json` の `build` スクリプトは `bun build daily-logbook.ts --outdir dist`（正しい）
- しかし `prepublishOnly` は `bun run build` を呼び、npm に公開される `package.json` の `scripts.build` は `.github/plugins/daily-logbook.ts` を参照（古いパス）

**影響**:
- `npm publish` 時にビルドが失敗する
- バージョン番号の不一致により混乱を招く

**修正案**:
1. `package.json` の `scripts.build` を確認し、实际のソースパスに統一:
   ```json
   "build": "bun build daily-logbook.ts --outdir dist --target=bun --outfile index.js"
   ```
   （これはローカルの `package.json` では正しい。npm に公開されるバージョンを確認すること）

2. バージョンを `1.0.8` に更新し、`CHANGELOG.md` も更新して `npm publish` し直す

---

### 🟡 Issue 3: README Method B のビルドパスが間違っている

**優先度**: 🟡 中

**問題**:
README.md / README.jp.md の「方法 B. ソースからコピー」で `bun build .github/plugins/daily-logbook.ts` を指定しているが、`.github/plugins/` は空ディレクトリでファイルがない。

**発見した事実**:
- `.github/plugins/` は空
- ソースファイルはルートの `daily-logbook.ts`

**影響**:
- ユーザーがこのコマンドを実行すると `error: file not found` で失敗する

**修正案**:
README.md / README.jp.md の Method B を修正:

```bash
# 修正前
bun build .github/plugins/daily-logbook.ts --outdir /tmp/build --target=bun

# 修正後
bun build daily-logbook.ts --outdir /tmp/build --target=bun
```

---

### 🟡 Issue 4: アンインストール手順が存在しない

**優先度**: 🟡 中

**問題**:
README.md / README.jp.md にアンインストール手順が記載されていない。

**影響**:
- ユーザーがプラグインを削除する方法が不明
- `npm uninstall -g` だけでは設定ファイル（`opencode.json` / `opencode.jsonc`）とキャッシュが残る

**修正案**:
README にアンインストールセクションを追加:

```markdown
## Uninstall

### Method A. npm install でインストールした場合

```bash
# 1. npm パッケージをアンインストール
npm uninstall -g opencode-autopilot-logbook

# 2. OpenCode の設定ファイルからプラグインを削除
# ~/.config/opencode/opencode.json または opencode.jsonc の
# plugin 配列から "opencode-autopilot-logbook" を削除

# 3. キャッシュをクリア
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*

# 4. OpenCode を再起動
```

### Method B. ソースからコピーした場合

```bash
# 1. プラグインファイルを削除
rm ~/.config/opencode/plugins/daily-logbook.js

# 2. OpenCode の設定ファイルからプラグインを削除
# ~/.config/opencode/opencode.json または opencode.jsonc の
# plugin 配列から "~/.config/opencode/plugins/daily-logbook.ts" を削除

# 3. OpenCode を再起動
```
```

---

### 🟡 Issue 5: opencode.json にプラグインエントリが重複

**優先度**: 🟡 中

**問題**:
`opencode plugin -g` 実行後、`opencode.json` の `plugin` 配列にローカルパスと npm モジュール名の両方が追加される:

```json
"plugin": [
    "~/.config/opencode/plugins/daily-logbook.ts",
    "opencode-autopilot-logbook"
]
```

**影響**:
- 同じプラグインが2回ロードされる可能性
- 哪一个が優先されるか不明確

**修正案**:
README に以下の注意書きを追加:

```markdown
> `opencode plugin` コマンドはローカルパスとモジュール名の両方を登録することがあります。
> 不要な方は `opencode.json` から削除してください。
```

---

### 🟢 Issue 6: npm アンインストール後にキャッシュが残存

**優先度**: 🟢 低

**問題**:
`npm uninstall -g opencode-autopilot-logbook` を実行しても、`~/.cache/opencode/packages/opencode-autopilot-logbook@latest/` は削除されない。

**影響**:
- 再インストール時に古いキャッシュが使われる可能性がある
- README のキャッシュクリア手順は「No plugin targets found」エラー時のみ言及

**修正案**:
アンインストール手順（Issue 4 と統合）にキャッシュクリアを含める。

---

## 検証結果まとめ

| チェック項目 | 結果 |
|------------|------|
| README の `npm install -g` → `opencode plugin -g` フロー | ⚠️ 動作するが設定ファイルの問題あり |
| README Method B のビルドコマンド | ❌ パスが間違っている |
| アンインストール手順 | ❌ 記載なし |
| 環境変数の記載 | ✅ 正しい |
| package.json のバージョン | ❌ npm レジストリと不一致 |
| CHANGELOG の整合性 | ❌ 1.0.5 で止まっている |

## 推奨アクション優先順位

1. **Issue 2 (🔴)**: package.json のバージョン更新とビルドスクリプト修正 → `npm publish`
2. **Issue 1 (🔴)**: 設定ファイルの問題を README で明記
3. **Issue 3 (🟡)**: README Method B のパス修正
4. **Issue 4 (🟡)**: アンインストール手順の追加
5. **Issue 5 (🟡)**: 重複エントリの注意書き追加
6. **Issue 6 (🟢)**: キャッシュクリア手順の統合
