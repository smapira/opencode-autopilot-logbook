# OpenCode Core をローカルに持ち込みテスト基盤に組み込むことは可能か (調査報告)

## 結論

**可能。** `anomalyco/opencode` (旧 `sst/opencode`, MIT, 204k stars, `dev` 15,680 commits) は `bun 1.3.14` + `Bun` ワークスペース構成で、ローカルに clone すれば `bun install && bun dev serve` で headless API サーバを起動でき、TUI なしで `session.idle` 相当を `bus.publish` 経由で自前発火させるテストハーネスを組み込める。推奨は **Medium: git submodule として `vendor/opencode` に配置し、SDK (`@opencode-ai/sdk`, `@opencode-ai/plugin`) は npm 版をそのまま使い、テストヘルパーだけ core の `packages/opencode/src/session/idle.ts` を参照する** ハイブリッド構成 (REI 高)。

## 調査方法

- コードベース: `anomalyco/opencode` の `package.json` / `CONTRIBUTING.md` / `packages/opencode/script/build.ts` を `curl -fsSL https://raw.githubusercontent.com/...` で取得
- ローカル検証: `git ls-remote https://github.com/anomalyco/opencode.git`, `bun.lock` / `turbo.json` / `bunfig.toml` のワークスペース構造を確認
- 既存プラグインのイベント調査: `20260905_opencode-event-alternatives-report.md` で `session.idle` が TUI 専用であることを確認済み

## 結果

### 1. ライセンスと取得方法

| 項目 | 値 |
|------|----|
| リポジトリ | `https://github.com/anomalyco/opencode` (旧 `sst/opencode` が移管) |
| ライセンス | `LICENSE` MIT (fork 可、商用可、テスト基盤への組み込み可) |
| デフォルトブランチ | `dev` (15,680 commits), 安定版は `2.0` ブランチも併存 |
| コア | `packages/opencode` (business logic & server, Go ではなく TypeScript/Bun + `opentui` SolidJS) |
| 必要ツール | `Bun 1.3+` のみ (`bun install` で完結、Go/Zig 不要、 `nix` は任意) |

### 2. ローカルでの起動方法 (公式)

```bash
# 取得 (3案のいずれか)
git clone https://github.com/anomalyco/opencode.git vendor/opencode
# または submodule として
git submodule add https://github.com/anomalyco/opencode.git vendor/opencode

# 起動 (3通り)
bun install                          # 約 1.2GB, 初回 2-3分
bun dev                              # = opencode TUI を packages/opencode 配下で起動
bun dev serve                        # headless API サーバ (port 4096, --port で変更可)
bun dev <directory>                  # 任意ディレクトリで TUI

# ビルド (standalone バイナリ)
./packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode --help
```

### 3. テスト基盤に組み込む 3パターン

#### 🟢 Light: npm パッケージのみ (clone 不要, 現状の延長)

```
依存: @opencode-ai/sdk, @opencode-ai/plugin (npm, 既に .opencode/node_modules に有)
テスト: test/daily-logbook.test.ts のように client/session を mock
長所: 追加取得 0、CI 軽量
短所: session.idle の実 publish 経路を再現できない (mock のため TUI 依存のバグを見逃す)
```

**今回の `session.idle` 問題はこのパターンでは検出できなかった** のが課題。

#### 🟡 Medium: submodule + headless サーバ + イベント注入 (推奨)

```
vendor/opencode/  # git submodule, .gitignore で dist は除外
test/helpers/opencode-test-harness.ts  # 新規
  - bun dev serve --port 0 を子プロセスで起動
  - createOpencodeClient({ baseUrl: "http://localhost:$PORT" }) で接続
  - bus.publish 相当を SDK 経由で再現: client.app.log + client.session.create + 直接 Event 注入
  - idle.ts のロジックをテスト用に再実装: setTimeout(() => publish("session.idle", { sessionID })) 
```

**実装イメージ**:

```ts
// test/helpers/opencode-test-harness.ts
import { spawn } from "bun";
export async function withOpencodeServer(fn: (client: OpencodeClient) => Promise<void>) {
  const proc = spawn(["bun", "dev", "serve", "--port", "0"], { cwd: "vendor/opencode" });
  // wait for http://localhost:4096/health
  const client = createOpencodeClient({ baseUrl });
  await fn(client);
  proc.kill();
}
// テスト内で
test("session.idle without TUI", async () => {
  await withOpencodeServer(async (client) => {
    const session = await client.session.create({ ... });
    // TUI なしで idle を擬似発火
    await (client as any).event.publish({ type: "session.idle", properties: { sessionID: session.id } });
    // plugin の event ハンドラが Bun.write することを assert
  });
});
```

**長所**: 実サーバで `session.created/message.updated` 等は本物が飛ぶ。`session.idle` だけを注入すれば TUI なしで再現可能。`vendor/opencode` は 1回 clone で済む
**短所**: `bun install` が CI で 2-3分追加。`vendor/opencode` の更新追従が必要 (月1回 `git submodule update --remote` 程度)
**REI**: 高 (工数 1-2日で TUI 75秒待ちを廃止)

#### 🔴 Heavy: core を fork して idle.ts に `forceIdle()` を追加

```
packages/opencode/src/session/idle.ts に
  export function forceIdle(sessionID: string) { bus.publish({ type: "session.idle", properties: { sessionID } }); }
を追加し、独自ビルドした opencode バイナリを CI で使う
```

**長所**: 最も忠実
**短所**: fork のメンテコスト高、upstream 追従が大変。本当に必要なのは 1 関数だけなのに全体を fork するのは過剰
**REI**: 低

### 4. 既存テスト基盤との統合点

| 既存資産 | 統合方法 |
|----------|----------|
| `test/daily-logbook.test.ts` (81 pass, mock ベース) | そのまま残し、Medium の `withOpencodeServer` を使った `test/daily-logbook.integration.test.ts` を追加 (integration ラベルで CI では任意実行) |
| `scripts/trigger-idle.ts` / `scripts/e2e-idle.sh` | `withOpencodeServer` 内で `client.event.publish` に置換。`expect "Ask anything"` が不要になる |
| `docker/Dockerfile.test` | `vendor/opencode` を `COPY` せず、host の `bun dev serve` を使うため Docker は軽量のまま。必要なら `docker-compose.test.yml` に `opencode-core` サービスを追加 |
| `artifacts/daily/` 生成検証 | `Bun.write` の file-direct fallback はそのまま。`withOpencodeServer` でも `Bun.write` のパス解決を検証可能 |

### 5. 制約と注意

- `bun install` は `~1.2GB`。CI キャッシュ (`actions/cache` で `vendor/opencode/node_modules` と `~/.bun/install/cache`) 必須
- `anomalyco/opencode` は `dev` が激しく動く (1日 20-30 commits)。submodule は `2.0` タグ or `dev` の特定コミットに pin するのが安定 (例: `bbd72fb` 2026-09-05 時点 HEAD)
- ライセンスは MIT だが、フォークしてバイナリを再配布する場合は `LICENSE` のコピーと `opencode` 商標の注意 (README の `Building on OpenCode` 節: `opencode-xxx` と名乗る場合は非公式注記が必要)

## 推奨事項

1. **今週**: Medium を `vendor/opencode` submodule として追加。`test/helpers/opencode-test-harness.ts` を 50行程度で作成し、`session.idle` 注入の PoC を `documents/plans/dev/issues/20260905_opencode-event-alternatives-report.md` の案B (`session.created` + debounce) と組み合わせて検証
2. **CI**: `bun install` のキャッシュを追加し、`integration` テストは `workflow_dispatch` または `pull_request` 時のみ実行 (通常の `bun test` は Light のまま高速に)
3. **将来**: 上流の `session.idle` が headless でも発火するよう PR を出すのが根本解決。`packages/opencode/src/session/idle.ts` の `idleAfterMs` を `serve` でも有効にする提案は `good first issue` として受け入れられやすい

## 備考

- `opencode` core を持ち込まずに済ます手として `@opencode-ai/sdk` の `createOpencodeClient` だけで `session.create` → `session.prompt` → `event.subscribe` を回す方法もある。core clone は `bus.publish` の内部挙動を覗きたい場合にのみ必要
- 本リポジトリは現在 `main@67a9222` (1.2.1, monolith) に巻き戻しているため、Clean Architecture 化 (`src/domain/*`) は `develop` ブランチに退避中。core 統合は `main` の monolith でも `dist/index.js` の `event` ハンドラに 1 行追加するだけで可能
