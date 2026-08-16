---
name: opencode-plugin-publish
description: |
  OpenCode プラグインを開発し、npm に公開するスキル。
  「プラグイン作成」「プラグイン公開」「opencode plugin 作って」「npm publish して」
  などの依頼で使う。
---

# OpenCode Plugin Publish

OpenCode プラグインを開発し、npm に公開する。

## プラグイン構造

```
my-plugin/
├── package.json
├── my-plugin.ts
├── dist/
│   └── index.js
├── README.md
├── README.jp.md
└── CHANGELOG.md
```

## package.json テンプレート

```json
{
  "name": "opencode-my-plugin",
  "version": "1.0.0",
  "description": "OpenCode plugin that ...",
  "type": "module",
  "main": "dist/index.js",
  "files": ["dist", "README.md", "README.jp.md", "CHANGELOG.md"],
  "scripts": {
    "build": "bun build my-plugin.ts --outdir dist --target=bun --outfile index.js",
    "prepublishOnly": "bun run build"
  },
  "engines": { "node": ">=18.0.0" },
  "keywords": ["opencode", "opencode-plugin"],
  "peerDependencies": { "bun": ">=1.0.0" },
  "devDependencies": { "@opencode-ai/plugin": "^1.0.0" },
  "repository": { "type": "git", "url": "https://github.com/user/repo.git" },
  "license": "MIT"
}
```

**重要**:
- `main: "dist/index.js"` が必須（`exports` ではない）
- `type: "module"` が必須
- `files` に `dist` を含める
- `prepublishOnly` でビルドを自動実行

## プラグイン ソース テンプレート

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ client, directory, $ }) => {
  await client.app.log({
    body: {
      service: "my-plugin",
      level: "info",
      message: "Plugin loaded",
    },
  })

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // セッションアイドル時の処理
      }
    },
  }
}
```

## 利用可能なイベント

| イベント | 発火タイミング |
|---------|---------------|
| `session.idle` | セッションがアイドル状態になった時 |
| `session.created` | セッション作成時 |
| `session.compacted` | セッション圧縮時 |
| `message.updated` | メッセージ更新時 |
| `tool.execute.after` | ツール実行後 |
| `permission.asked` | 権限リクエスト時 |

## プラグイン関数の引数

```typescript
async ({ client, directory, worktree, $, project }) => {
  // client: OpenCode SDK クライアント
  // directory: カレントディレクトリ
  // worktree: git worktree パス
  // $: Bun の shell API
  // project: プロジェクト情報
}
```

## ビルド手順

```bash
bun build my-plugin.ts --outdir dist --target=bun --outfile index.js
```

## npm 公開手順

```bash
# 1. ログイン
npm login

# 2. バージョン更新
npm version patch

# 3. 公開（prepublishOnly が自動でビルド）
npm publish --access public
```

## インストール手順（ユーザー向け）

```bash
# インストール
npm install -g opencode-my-plugin
opencode plugin opencode-my-plugin -g

# キャッシュエラーの場合
rm -rf ~/.cache/opencode/packages/opencode-my-plugin*
opencode plugin opencode-my-plugin -g

# アンインストール
opencode plugin opencode-my-plugin -g --remove
npm uninstall -g opencode-my-plugin
rm -rf ~/.cache/opencode/packages/opencode-my-plugin*
```

## 注意事項

- `~/.cache/opencode/packages/` にキャッシュが残ると古いバージョンが使われる
- `opencode plugin` は `.ts` ファイルを配置するが、`.js` の方が安定動作する
- `opencode.jsonc` にプラグインが登録されることを確認する
- ローカルテスト: `.opencode/plugins/` にコピーして確認
