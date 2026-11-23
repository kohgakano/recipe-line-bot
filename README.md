# レシピ共有 LINE Bot セットアップ手順

構成(すべて無料枠): **LINE公式アカウント / Google Apps Script / Googleスプレッドシート(DB) / Gemini API / GitHub Pages(確認・修正フォーム)**

```
gas/Code.gs         … Bot本体(GASに貼り付け、またはclaspで反映)
gas/appsscript.json … マニフェスト(権限・公開設定)
docs/index.html     … 確認・修正フォーム(LIFF)。GitHub Pagesで公開される
docs/config.js      … フォームの設定(あなたの値に書き換える)
```

## 全体の流れ(この順に進めてください)
1. LINE公式アカウントを作り、Messaging APIを有効にする
2. **GitHubに公開する**(→ LIFFのエンドポイントURLが決まる)
3. LINEログインチャネルを作り、LIFFアプリを登録する(→ LIFF IDが決まる)
4. Gemini APIキーを取る
5. スプレッドシート + GASを設定する(→ GASのURLが決まる)
6. `docs/config.js` にLIFF IDとGASのURLを入れて、GitHubに反映する
7. Webhookを設定する
8. 動作確認

## 1. LINE公式アカウントと Messaging API
※ 以前と違い、LINE Developersコンソールから Messaging API チャネルを**直接作ることはできません**。先に公式アカウントを作り、そこで Messaging API を有効にします。

1. **LINE公式アカウントを作成**: [ビジネスID](https://account.line.biz/signup?redirectUri=https://entry.line.biz/form/entry/unverified)に登録(LINEアカウントかメールアドレス)→ 作成フォームに入力 → [LINE Official Account Manager](https://manager.line.biz/) で作成を確認(作成にはSMSか音声通話で電話番号の認証が必要です)
2. **Messaging API を有効化**: Official Account Manager の「設定」→「Messaging API」→ 利用を開始
   - 開発者情報(名前・メール)の登録画面が出たら入力
   - **プロバイダーを選択**(新規作成でOK。**あとから変更・解除できません**。手順3のLINEログインチャネルも**同じプロバイダー**で作ります)
3. [LINE Developersコンソール](https://developers.line.biz/console/)に同じアカウントでログインし、そのプロバイダーの下にチャネルができていることを確認
   - 「Messaging API設定」→ **チャネルアクセストークン(長期)** を発行して控える
   - 同じ画面のQRコードで、自分のLINEに友だち追加しておく
4. 応答メッセージ・あいさつメッセージは **オフ**(Official Account Manager の「応答設定」)

## 2. GitHubに公開する(GitHub Pages)
フォームは `docs/` フォルダがそのまま公開されます。**先に公開してURLを決める**ことで、手順3でLIFFに登録できます。

1. GitHubで新規リポジトリを作る(**Public**。GitHub Pagesの無料プランは公開リポジトリが前提です)
2. このプロジェクトをpushする(`gas/` `docs/` など全部)。この時点で `docs/config.js` は初期値のままでOK
3. リポジトリの Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / フォルダ `/docs` にして Save
4. しばらくすると公開される。次のURLをコピー(これが **LIFFのエンドポイントURL**)

```
https://<GitHubユーザー名>.github.io/<リポジトリ名>/
```

- 公開されるのは `docs/` の中身だけです。`gas/` のコードも同じリポジトリに入りますが、Pagesとしては公開されません(ただしリポジトリ自体がPublicなので、**APIキーやトークンはコードやconfig.jsに絶対書かないでください**。キーはGASのスクリプトプロパティにだけ入れます)

## 3. LINEログインチャネルとLIFFアプリ
1. 手順1と**同じプロバイダー**の中に「LINEログイン」チャネルを新規作成(LIFF用。ここはコンソールから作れます)
2. **Channel ID** を控える
3. 「LIFF」タブ → 追加:
   - サイズ: **Full**
   - エンドポイントURL: 手順2のGitHub PagesのURL
   - Scope: **openid**(必須)
   - 作成後に表示される **LIFF ID** を控える
4. 「基本設定」→「リンクされたLINE公式アカウント」に、手順1の公式アカウントを設定
5. チャネルの公開状態を「公開済み」にする(開発中のままだと、あなた以外が開けません)

## 4. Gemini APIキー
[Google AI Studio](https://aistudio.google.com/) → Get API key → 作成して控える(無料枠)。
※無料枠に送った内容はGoogleの製品改善に使われる場合があります。

## 5. Google スプレッドシート + GAS
1. 新しいスプレッドシートを作成 → メニュー「拡張機能」→「Apps Script」
2. `Code.gs` の中身を `gas/Code.gs` で置き換える
3. 左の歯車「プロジェクトの設定」→「"appsscript.json" マニフェスト ファイルをエディタで表示する」にチェック → `appsscript.json` を `gas/appsscript.json` で置き換える
4. 「スクリプト プロパティ」に以下を追加

| プロパティ | 値 |
|---|---|
| LINE_CHANNEL_ACCESS_TOKEN | 手順1-3のトークン |
| WEBHOOK_KEY | 推測されにくい文字列(英数字20文字以上) |
| LIFF_ID | 手順3のLIFF ID |
| LIFF_CHANNEL_ID | 手順3のLINEログインチャネルのChannel ID |
| GEMINI_API_KEY | 手順4のキー |
| GEMINI_MODELS | (任意)使うGeminiモデルをカンマ区切りで優先順に。既定は `gemini-flash-latest,gemini-flash-lite-latest`。AI Studioで実在するモデル名に合わせてください |
| GROQ_API_KEY | (任意)画像解析のフォールバック先。[Groq](https://console.groq.com/)のAPIキー(無料・カード不要) |
| GROQ_MODELS | (任意)既定は `meta-llama/llama-4-scout-17b-16e-instruct`(画像入力対応のモデルを指定) |
| OPENROUTER_API_KEY | (任意)画像解析のさらに先のフォールバック。[OpenRouter](https://openrouter.ai/)のキー |
| OPENROUTER_MODELS | (任意)既定は `openrouter/free`(無料の画像対応モデルから自動選択) |
| IMAGE_PROVIDERS | (任意)画像解析で試す順。既定は `gemini,groq,openrouter` |
| ALLOWED_IDS | (任意)使える人のuserId/groupIdをカンマ区切り。空なら誰でも使える |

5. 関数 `setup` を選んで **実行**(権限を承認)→ シート「recipes」が作られます
6. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 次のユーザーとして実行: **自分** / アクセスできるユーザー: **全員**
   - 発行された **ウェブアプリURL**(`…/exec`)を控える

## 6. フォームの設定を反映する
1. `docs/config.js` の `LIFF_ID`(手順3)と `GAS_URL`(手順5のウェブアプリURL。`?key=` は付けない)を書き換える
2. GitHubにpushする(Pagesが自動で更新されます。反映まで数分かかることがあります)

## 7. Webhook設定
LINE Developers の Messaging API 設定 → Webhook URL に

```
<ウェブアプリURL>?key=<WEBHOOK_KEY>
```

を設定 → 「検証」→ 成功したら「Webhookの利用」をオン。

## 8. 動作確認
公式アカウントを友だち追加し、YouTubeのURL(公開動画)を送る → 確認画面が出ます。

## clasp でGASをコマンドから更新する(任意)
エディタに貼り付ける代わりに、手元のファイルをコマンドでGASへ反映できます。

1. [Node.js](https://nodejs.org/) を入れる
2. https://script.google.com/home/usersettings で **Google Apps Script API をオン**にする
3. プロジェクト直下で `npm run login`(ブラウザでGoogleにログイン)
4. GASエディタの「プロジェクトの設定」にある **スクリプトID** を、`.clasp.json` の `scriptId` に入れる
5. `npm run push` で `gas/` の内容(`Code.gs` と `appsscript.json`)がGASに反映される

- 反映は**下書きのコード**への上書きです。ウェブアプリに反映するには、GASエディタの「デプロイを管理」→ 既存のデプロイを編集 → 新バージョン、で更新してください(URLは変わりません)。コマンドで更新する場合は `npx @google/clasp deploy --deploymentId <デプロイID>` です(コマンドは版により異なるので、`npx @google/clasp --help` で確認してください)
- `npm run watch` で保存のたびに自動で反映されます
- **スクリプトプロパティ(各種キー)はclaspでは同期されません**。GASの画面で設定してください
- `.clasprc.json`(ログイン情報)はGitHubに上げないでください(`.gitignore` 済み)

## 無料枠の渡り歩き(画像解析)
画像は `IMAGE_PROVIDERS` の順に、**Geminiの各モデル → Groq → OpenRouter(:free)** と試します。無料枠切れ(429)やエラーなら自動で次へ進み、枠切れした先は5分間スキップします。確認カードの下に「解析: どこで解析したか」が出るので、フォールバック先(精度が落ちやすい)かどうか分かります。
- キーを設定したサービスだけが使われます(Geminiだけでも動きます)
- YouTube動画はURLを直接読めるのがGeminiだけなので、Geminiのモデル間でのみ切り替わります
- 1つのサービスで複数アカウント/キーを作って枠を増やす運用は、効果がない・規約上の問題があるため非対応です

## 家族で使うには
- 家族全員が公式アカウントを友だち追加すれば、**全員が同じレシピ集**を登録・検索できます(DBが1つのため)
- 登録(YouTube/画像/手動)は **1対1のトーク**で行います
- グループに招待した場合は「食材 〇〇」「料理 〇〇」「一覧」「おまかせ」だけ反応します(普通の会話や写真には反応しません)
- 自分のIDは「id」と送ると返信されます。`ALLOWED_IDS` に入れると家族以外を締め出せます

## 運用メモ
- **コードを変えたら**「デプロイを管理」→ 編集 → 新バージョンで更新(URLは変わりません)
- 解析の途中で放置された下書きは、`purgeOldDrafts` を毎日1回の時間トリガーに設定すると掃除されます
- LINEの無料プランはプッシュ送信に月間上限があります。1対1の解析はローディング表示+返信で完結する作りなので通常は消費しませんが、解析が1分を超えた場合のみプッシュになります
- GASはLINEの署名ヘッダを読めないため、WebhookのURLに付けた `key` で簡易認証しています。URLは公開しないでください
- すべての解析先が429になったら、時間をおいてください(Geminiの1日の枠は太平洋時間の0時にリセット)
- YouTubeは**公開**動画のみ解析できます(限定公開・非公開は不可)

## 追加でやりたくなりそうなこと
- リッチメニュー(「一覧」「おまかせ」「手動登録」ボタン)をLINE Official Account Managerで作成
- 献立・買い物リスト機能(複数レシピの材料をまとめる)
- 「食材を除外」検索(例: 鶏肉 -玉ねぎ)
