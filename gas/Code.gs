/**
 * レシピ共有 LINE Bot (Google Apps Script)
 *  - YouTube URL / 画像 → Gemini で解析 → 下書き → LIFFで確認・修正 → 保存
 *  - 食材名・料理名で検索、レシピ表示
 *  - DB は このスクリプトに紐づくスプレッドシート(シート名: recipes)
 *
 * スクリプトプロパティ(プロジェクトの設定 → スクリプト プロパティ):
 *   LINE_CHANNEL_ACCESS_TOKEN  Messaging API のチャネルアクセストークン(長期)
 *   WEBHOOK_KEY                Webhook URL に付ける合言葉(推測されにくい文字列)
 *   LIFF_ID                    LIFFアプリのID
 *   LIFF_CHANNEL_ID            LIFFを作った LINEログインチャネルの Channel ID
 *   GEMINI_API_KEY             Google AI Studio のAPIキー
 *   GEMINI_MODELS              (任意) 使うモデルをカンマ区切りで優先順に。既定: gemini-flash-latest,gemini-flash-lite-latest
 *   GROQ_API_KEY / GROQ_MODELS             (任意) 画像解析のフォールバック先(Groq)
 *   OPENROUTER_API_KEY / OPENROUTER_MODELS (任意) 画像解析のフォールバック先(OpenRouterの:free)
 *   IMAGE_PROVIDERS            (任意) 画像解析の試す順。既定: gemini,groq,openrouter
 *   ALLOWED_IDS                (任意) 使える人のuserId/groupIdをカンマ区切り。空なら誰でも可
 */

const SHEET_NAME = 'recipes';
const HEADERS = ['id', 'status', 'title', 'servings', 'ingredients', 'steps', 'ingredient_index',
  'source_type', 'source_url', 'memo', 'created_by', 'created_at', 'updated_at'];
const MAX_LIST = 12;

const HELP = [
  '🍳 レシピBotの使い方',
  '',
  '【登録】(1対1のトークで)',
  '・YouTubeのURLを送る → 動画からレシピを作成',
  '・料理の写真/レシピ画像を送る → 画像からレシピを作成',
  '  (材料と手順が別の画像でもOK。最大5枚まで1つのレシピにまとめます)',
  '  まとめて選んで送ると自動で解析。1枚ずつ送った場合は、全部送ってから「解析」と送ります(「キャンセル」で取り消し)',
  '・「手動登録」 → 自分で入力',
  '解析後は確認画面が出るので、修正して保存できます。',
  '',
  '【検索】',
  '・食材名を送る(例: 鶏肉 / 鶏肉 玉ねぎ)→ その食材を使うレシピ一覧',
  '・料理名を送る(例: 肉じゃが)→ レシピを表示',
  '・「食材 〇〇」「料理 〇〇」と頭に付けると種類を指定できます',
  '・「一覧」→ 最近のレシピ / 「おまかせ」→ ランダム',
  '',
  '※グループでは「食材 〇〇」「料理 〇〇」「一覧」「おまかせ」が使えます。',
].join('\n');

/* ============================== エントリポイント ============================== */

function doGet() {
  return ContentService.createTextOutput('recipe bot is running');
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (Array.isArray(body.events)) {
      // LINE Webhook (GASは署名ヘッダを読めないため、URLのkeyで簡易認証)
      if (!e.parameter || e.parameter.key !== prop_('WEBHOOK_KEY')) {
        return jsonOut_({ ok: false, error: 'forbidden' });
      }
      body.events.forEach(function (ev) {
        try {
          handleEvent_(ev);
        } catch (err) {
          console.error(err.stack || err);
          try { send_(ev, text_('処理中にエラーが起きました。もう一度お試しください。\n' + String(err.message || err).slice(0, 200))); } catch (e2) { /* noop */ }
        }
      });
      return jsonOut_({ ok: true });
    }
    return handleApi_(body); // LIFFフォームからのAPI
  } catch (err) {
    console.error(err.stack || err);
    return jsonOut_({ ok: false, error: String(err.message || err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k) || '';
}

/** 初回に1度だけ実行: シートを作成 */
function setup() {
  sheet_();
  console.log('OK: シート「' + SHEET_NAME + '」を準備しました');
}

/** 時間トリガー(1日1回など)に設定すると、放置された下書きを掃除します */
function purgeOldDrafts() {
  const limit = Date.now() - 3 * 24 * 3600 * 1000;
  const all = readAll_().filter(function (r) { return r.status === 'draft' && ts_(r.created_at) < limit; });
  all.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { deleteRecipe_(r.id); });
}

/* ============================== LINE イベント処理 ============================== */

function handleEvent_(ev) {
  if (ev.webhookEventId) {
    const cache = CacheService.getScriptCache();
    if (cache.get('ev_' + ev.webhookEventId)) return; // 再送の重複排除
    cache.put('ev_' + ev.webhookEventId, '1', 3600);
  }
  if (ev.type === 'follow' || ev.type === 'join') {
    send_(ev, text_(HELP));
    return;
  }
  // 許可リスト設定用: 自分のIDを確認するコマンド
  if (ev.type === 'message' && ev.message.type === 'text' && /^(id|ユーザーid|私のid)$/i.test(ev.message.text.trim())) {
    send_(ev, text_('userId: ' + (ev.source.userId || '-') + '\ngroupId: ' + (ev.source.groupId || ev.source.roomId || '-')));
    return;
  }
  if (!isAllowedSource_(ev.source)) return;

  if (ev.type === 'message') {
    if (ev.message.type === 'text') return onText_(ev, ev.message.text);
    if (ev.message.type === 'image') return onImage_(ev);
  } else if (ev.type === 'postback') {
    return onPostback_(ev);
  }
}

function isAllowedSource_(src) {
  const list = prop_('ALLOWED_IDS');
  if (!list) return true;
  const ids = list.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return [src.userId, src.groupId, src.roomId].some(function (id) { return id && ids.indexOf(id) >= 0; });
}

function isGroup_(ev) {
  return ev.source.type !== 'user';
}

function onText_(ev, raw) {
  const t = raw.trim();
  if (!t) return;

  const ytId = extractYouTubeId_(t);
  if (ytId && !isGroup_(ev)) return onYouTube_(ev, ytId);

  if (/^(ヘルプ|help|使い方|\?|？)$/i.test(t)) return send_(ev, text_(HELP));

  if (!isGroup_(ev) && /^(解析|解析する|まとめて解析|完了)$/.test(t)) return onAnalyzeCommand_(ev);
  if (!isGroup_(ev) && /^(キャンセル|取り消し|取消)$/.test(t)) {
    const n = clearQueue_(ev.source.userId).length;
    return send_(ev, text_(n ? '預かっていた画像 ' + n + '枚を破棄しました。' : '預かっている画像はありません。'));
  }

  if (/^(一覧|レシピ一覧|新着)$/.test(t)) {
    const rs = confirmed_().sort(byNewest_);
    if (!rs.length) return send_(ev, text_('まだレシピが登録されていません。YouTubeのURLか画像を送ってみてください。'));
    return send_(ev, listFlex_(rs, '最近のレシピ'));
  }
  if (/^(ランダム|おまかせ|今日のごはん|今日の献立)$/.test(t)) {
    const rs = confirmed_();
    if (!rs.length) return send_(ev, text_('まだレシピが登録されていません。'));
    return send_(ev, recipeFlex_(rs[Math.floor(Math.random() * rs.length)]));
  }
  if (/^(手動登録|新規作成|レシピ登録)$/.test(t)) {
    if (isGroup_(ev)) return send_(ev, text_('登録は1対1のトークで行ってください。'));
    const r = saveNew_({ source_type: 'manual', created_by: ev.source.userId || '' });
    if (!liffUrl_(r.id)) return send_(ev, text_('LIFF_ID が未設定です。'));
    return send_(ev, text_('こちらから入力してください👇\n' + liffUrl_(r.id)));
  }

  let m = t.match(/^(食材|材料)[\s:：]+(.+)$/);
  if (m) return searchByIngredients_(ev, m[2]);
  m = t.match(/^(料理|レシピ)[\s:：]+(.+)$/);
  if (m) return searchByTitle_(ev, m[2]);

  if (isGroup_(ev)) return; // グループでは普通の会話に反応しない
  return smartSearch_(ev, t);
}

/* ---------- 画像: 複数枚を預かって1つのレシピにまとめる ---------- */

const IMG_MAX = 5;                 // 1レシピにまとめる最大枚数(予備先のGroqが1回5枚まで)
const IMG_TTL_MS = 30 * 60 * 1000; // 預かった画像を捨てるまでの時間
const IMG_TOTAL_MAX_BYTES = 14 * 1024 * 1024; // Geminiのinline上限(約20MB)に対する安全マージン

function queueKey_(uid) { return 'imgq_' + uid; }

function loadQueue_(uid) {
  const raw = CacheService.getScriptCache().get(queueKey_(uid));
  let q = { items: [], warned: false };
  if (raw) { try { q = JSON.parse(raw); } catch (e) { /* noop */ } }
  const now = Date.now();
  q.items = (q.items || []).filter(function (i) { return now - i.ts < IMG_TTL_MS; });
  return q;
}

function saveQueue_(uid, q) {
  const cache = CacheService.getScriptCache();
  if (!q.items.length) cache.remove(queueKey_(uid));
  else cache.put(queueKey_(uid), JSON.stringify(q), 3600);
}

/** 預かっている画像を取り出して空にする(送った順に並べて返す) */
function takeQueue_(uid) {
  return withLock_(function () {
    const q = loadQueue_(uid);
    saveQueue_(uid, { items: [], warned: false });
    return sortItems_(q.items);
  });
}
function clearQueue_(uid) { return takeQueue_(uid); }

/** 解析に失敗したとき、画像を預かった状態に戻す(再試行できるように) */
function restoreQueue_(uid, items) {
  withLock_(function () {
    const q = loadQueue_(uid);
    items.forEach(function (i) { if (!q.items.some(function (x) { return x.id === i.id; })) q.items.push(i); });
    saveQueue_(uid, q);
  });
}

/** 同時送信の画像は index 順、別々に送った画像は到着順 */
function sortItems_(items) {
  const first = {};
  items.forEach(function (i) {
    const k = i.set || i.id;
    first[k] = first[k] === undefined ? i.ts : Math.min(first[k], i.ts);
  });
  return items.slice().sort(function (a, b) {
    return (first[a.set || a.id] - first[b.set || b.id]) || (a.idx - b.idx);
  });
}

/**
 * 画像を1枚預かる。戻り値の status:
 *  dup=受信済み / full=上限 / ready=同時送信が全部そろった(items を解析する) / queued=預かった
 */
function queueImage_(uid, msg) {
  return withLock_(function () {
    const q = loadQueue_(uid);
    if (q.items.some(function (i) { return i.id === msg.id; })) return { status: 'dup' };
    if (q.items.length >= IMG_MAX) {
      const first = !q.warned;
      q.warned = true;
      saveQueue_(uid, q);
      return { status: 'full', first: first };
    }
    // 同時に選んで送った画像: imageSet.total が分かるときだけ自動で解析できる
    const set = msg.imageSet && msg.imageSet.id && msg.imageSet.total > 1 ? msg.imageSet : null;
    q.items.push({ id: msg.id, set: set ? set.id : '', idx: set ? (set.index || 0) : 0, ts: Date.now() });
    if (set && q.items.filter(function (i) { return i.set === set.id; }).length >= set.total) {
      saveQueue_(uid, { items: [], warned: false });
      return { status: 'ready', items: sortItems_(q.items) };
    }
    saveQueue_(uid, q);
    return { status: 'queued', count: q.items.length, inSet: !!set };
  });
}

function quickReplyAnalyze_() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: '解析する', text: '解析' } },
      { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } },
    ],
  };
}

function onImage_(ev) {
  if (isGroup_(ev)) return; // グループの写真には反応しない(無料枠の節約)
  const uid = ev.source.userId;
  if (!uid) return;
  const r = queueImage_(uid, ev.message);
  if (r.status === 'dup') return;
  if (r.status === 'full') {
    if (r.first) {
      send_(ev, { type: 'text', text: '1つのレシピにまとめられるのは最大' + IMG_MAX + '枚までです。\n預かった' + IMG_MAX + '枚で「解析」するか、「キャンセル」してやり直してください。', quickReply: quickReplyAnalyze_() });
    }
    return;
  }
  if (r.status === 'ready') return analyzeQueued_(ev, r.items);
  // 同時送信の途中の画像には返信しない(全部そろったら解析が始まる)。単独の画像は確認を返す
  if (!r.inSet) {
    send_(ev, { type: 'text', text: '📷 ' + r.count + '枚を預かりました(最大' + IMG_MAX + '枚)。\n続けて送るか、下のボタンで進めてください。', quickReply: quickReplyAnalyze_() });
  }
}

function onAnalyzeCommand_(ev) {
  const uid = ev.source.userId;
  const items = uid ? takeQueue_(uid) : [];
  if (!items.length) return send_(ev, text_('預かっている画像がありません。\n(解析中の場合は、そのままお待ちください。しばらく経った画像は自動で破棄されるので、もう一度送ってください)'));
  return analyzeQueued_(ev, items);
}

function analyzeQueued_(ev, items) {
  startWait_(ev, items.length + '枚の画像を解析中です…(20秒ほどかかります)');
  let data;
  try {
    const blobs = items.map(function (i) { return fetchLineContent_(i.id); });
    const total = blobs.reduce(function (sum, b) { return sum + b.getBytes().length; }, 0);
    if (total > IMG_TOTAL_MAX_BYTES) throw new Error('TOO_BIG');
    data = analyzeImages_(blobs);
  } catch (err) {
    const m = String(err.message || err);
    const hint = m === 'TOO_BIG' ? '' : '\n\n画像は預かったままです。「解析」で再試行、「キャンセル」で破棄できます。';
    if (m !== 'TOO_BIG') restoreQueue_(ev.source.userId, items);
    return send_(ev, { type: 'text', text: friendlyError_(err) + hint, quickReply: m === 'TOO_BIG' ? undefined : quickReplyAnalyze_() });
  }
  const r = saveNew_(Object.assign(data, { source_type: 'image', created_by: ev.source.userId || '' }));
  send_(ev, draftFlex_(r));
}

function onYouTube_(ev, videoId) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  startWait_(ev, 'YouTube動画を解析中です…(30秒〜1分ほどかかります)');
  let data;
  try {
    data = analyzeYouTube_(url);
  } catch (err) {
    return send_(ev, text_(friendlyError_(err)));
  }
  if (!data.title) data.title = youTubeTitle_(url);
  const r = saveNew_(Object.assign(data, { source_type: 'youtube', source_url: url, created_by: ev.source.userId || '' }));
  send_(ev, draftFlex_(r));
}

function onPostback_(ev) {
  const p = parseQuery_(ev.postback.data);
  const id = p.id || '';
  switch (p.a) {
    case 'show': {
      const r = getRecipe_(id);
      return send_(ev, r ? recipeFlex_(r) : text_('レシピが見つかりませんでした。'));
    }
    case 'save': {
      const r = updateRecipe_(id, { status: 'confirmed' });
      if (!r) return send_(ev, text_('この下書きは見つかりませんでした(破棄済みかもしれません)。'));
      return send_(ev, [text_('✅ 保存しました'), recipeFlex_(r)]);
    }
    case 'discard': {
      const r = getRecipe_(id);
      if (r && r.status === 'draft') deleteRecipe_(id);
      return send_(ev, text_('破棄しました。'));
    }
    case 'del': {
      const r = getRecipe_(id);
      if (!r) return send_(ev, text_('レシピが見つかりませんでした。'));
      return send_(ev, {
        type: 'template', altText: '削除の確認',
        template: {
          type: 'confirm', text: '「' + r.title.slice(0, 60) + '」を削除しますか?',
          actions: [
            { type: 'postback', label: '削除する', data: 'a=delok&id=' + id },
            { type: 'postback', label: 'やめる', data: 'a=noop' },
          ],
        },
      });
    }
    case 'delok': {
      const r = getRecipe_(id);
      if (!r) return send_(ev, text_('すでに削除されています。'));
      deleteRecipe_(id);
      return send_(ev, text_('🗑 削除しました: ' + r.title));
    }
    default:
      return send_(ev, text_('キャンセルしました。'));
  }
}

/* ============================== 検索 ============================== */

function norm_(s) {
  // 全角半角統一・小文字化・空白除去・カタカナ→ひらがな
  return String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    .replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
}

function tokens_(s) {
  return String(s).split(/[\s、,，・]+/).map(norm_).filter(Boolean);
}

function hasIngredients_(r, toks) {
  const idx = norm_(r.ingredient_index);
  return toks.every(function (t) { return idx.indexOf(t) >= 0; });
}

function confirmed_() {
  return readAll_().filter(function (r) { return r.status === 'confirmed'; });
}

function smartSearch_(ev, text) {
  const q = norm_(text);
  if (!q) return;
  const rs = confirmed_();
  const exact = rs.filter(function (r) { return norm_(r.title) === q; });
  if (exact.length === 1) return send_(ev, recipeFlex_(exact[0]));

  const toks = tokens_(text);
  const byTitle = rs.filter(function (r) { return norm_(r.title).indexOf(q) >= 0; });
  const byIng = rs.filter(function (r) { return byTitle.indexOf(r) < 0 && hasIngredients_(r, toks); });
  const hits = byTitle.concat(byIng.sort(byNewest_));

  if (hits.length === 1) return send_(ev, recipeFlex_(hits[0]));
  if (hits.length > 1) return send_(ev, listFlex_(hits, '「' + text + '」の検索結果'));
  send_(ev, text_('「' + text + '」に合うレシピは見つかりませんでした。\nYouTubeのURLや画像を送ると登録できます(「ヘルプ」で使い方)。'));
}

function searchByIngredients_(ev, text) {
  const toks = tokens_(text);
  const hits = confirmed_().filter(function (r) { return hasIngredients_(r, toks); }).sort(byNewest_);
  if (!hits.length) return send_(ev, text_('「' + text + '」を使うレシピは見つかりませんでした。'));
  send_(ev, listFlex_(hits, '「' + text.trim() + '」を使うレシピ'));
}

function searchByTitle_(ev, text) {
  const q = norm_(text);
  const hits = confirmed_().filter(function (r) { return norm_(r.title).indexOf(q) >= 0; }).sort(byNewest_);
  if (!hits.length) return send_(ev, text_('「' + text + '」というレシピは見つかりませんでした。'));
  if (hits.length === 1) return send_(ev, recipeFlex_(hits[0]));
  send_(ev, listFlex_(hits, '「' + text.trim() + '」の検索結果'));
}

function byNewest_(a, b) {
  return ts_(b.created_at) - ts_(a.created_at);
}

function ts_(v) {
  if (v instanceof Date) return v.getTime();
  return Date.parse(v) || 0;
}

/* ============================== Flex Message ============================== */

function text_(t) {
  return { type: 'text', text: String(t).slice(0, 4900) };
}

function liffUrl_(id) {
  const liffId = prop_('LIFF_ID');
  return liffId ? 'https://liff.line.me/' + liffId + '?id=' + id : '';
}

function draftFlex_(r) {
  const preview = r.ingredients.slice(0, 6).map(function (i) { return i.name; }).join('、') +
    (r.ingredients.length > 6 ? ' ほか' : '');
  const footer = [];
  const url = liffUrl_(r.id);
  if (url) footer.push({ type: 'button', style: 'primary', color: '#06C755', action: { type: 'uri', label: '内容を確認・修正', uri: url } });
  footer.push({ type: 'button', style: 'secondary', action: { type: 'postback', label: 'このまま保存', data: 'a=save&id=' + r.id } });
  footer.push({ type: 'button', style: 'link', action: { type: 'postback', label: '破棄', data: 'a=discard&id=' + r.id } });
  return {
    type: 'flex', altText: 'レシピを解析しました。内容を確認してください',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: '🍳 解析結果(まだ保存されていません)', size: 'xs', color: '#06C755', weight: 'bold', wrap: true },
          { type: 'text', text: r.title || '(料理名なし)', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: '材料 ' + r.ingredients.length + '点 / 手順 ' + r.steps.length + '工程', size: 'sm', color: '#888888' },
          { type: 'text', text: preview || '-', size: 'sm', color: '#555555', wrap: true },
          { type: 'text', text: '解析: ' + (r.via || '-'), size: 'xxs', color: '#aaaaaa', wrap: true },
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer },
    },
  };
}

function recipeFlex_(r) {
  const body = [
    { type: 'text', text: r.title || '(無題)', weight: 'bold', size: 'lg', wrap: true },
  ];
  if (r.servings) body.push({ type: 'text', text: r.servings, size: 'sm', color: '#888888', wrap: true });
  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: '【材料】', weight: 'bold', size: 'sm', margin: 'md' });
  r.ingredients.forEach(function (i) {
    body.push({
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'text', text: i.name || '-', size: 'sm', flex: 3, wrap: true },
        { type: 'text', text: i.amount || ' ', size: 'sm', flex: 2, align: 'end', color: '#666666', wrap: true },
      ],
    });
  });
  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: '【作り方】', weight: 'bold', size: 'sm', margin: 'md' });
  r.steps.forEach(function (s, idx) {
    body.push({
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'text', text: (idx + 1) + '.', size: 'sm', flex: 0, color: '#06C755' },
        { type: 'text', text: s || '-', size: 'sm', flex: 1, wrap: true },
      ],
    });
  });
  if (r.memo) {
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: '💡 ' + r.memo, size: 'xs', color: '#666666', wrap: true, margin: 'md' });
  }

  const footer = [];
  if (/^https?:\/\//.test(r.source_url)) {
    footer.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '元の動画/ページを開く', uri: r.source_url } });
  }
  if (liffUrl_(r.id)) footer.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '修正する', uri: liffUrl_(r.id) } });
  footer.push({ type: 'button', style: 'link', height: 'sm', color: '#cc3333', action: { type: 'postback', label: '削除', data: 'a=del&id=' + r.id } });

  return {
    type: 'flex', altText: r.title || 'レシピ',
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer },
    },
  };
}

function listFlex_(recipes, title) {
  const shown = recipes.slice(0, MAX_LIST);
  const rows = [];
  shown.forEach(function (r, i) {
    if (i > 0) rows.push({ type: 'separator' });
    rows.push({
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'xs',
      action: { type: 'postback', label: (r.title || '無題').slice(0, 20), data: 'a=show&id=' + r.id },
      contents: [
        { type: 'text', text: r.title || '(無題)', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: r.ingredients.slice(0, 5).map(function (x) { return x.name; }).join('、') || '-', size: 'xs', color: '#888888', wrap: true },
      ],
    });
  });
  const body = [
    { type: 'text', text: title + '(' + recipes.length + '件)', weight: 'bold', size: 'sm', wrap: true, color: '#06C755' },
    { type: 'separator', margin: 'md' },
  ].concat(rows);
  if (recipes.length > shown.length) {
    body.push({ type: 'text', text: '他 ' + (recipes.length - shown.length) + '件。食材を足すと絞り込めます(例: 鶏肉 玉ねぎ)', size: 'xs', color: '#888888', wrap: true, margin: 'md' });
  }
  body.push({ type: 'text', text: 'タップでレシピを表示', size: 'xxs', color: '#aaaaaa', margin: 'md' });
  return {
    type: 'flex', altText: title + ' ' + recipes.length + '件',
    contents: { type: 'bubble', size: 'mega', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body } },
  };
}

/* ============================== LINE API ============================== */

function lineFetch_(url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) console.warn('LINE API ' + code + ': ' + res.getContentText());
  return { ok: code === 200, code: code };
}

/** replyTokenが使えれば返信(無料)、だめならプッシュ */
function send_(ev, msgs) {
  msgs = [].concat(msgs);
  if (ev.replyToken && !ev._replyUsed) {
    ev._replyUsed = true;
    if (lineFetch_('https://api.line.me/v2/bot/message/reply', { replyToken: ev.replyToken, messages: msgs }).ok) return;
  }
  const to = ev.source.groupId || ev.source.roomId || ev.source.userId;
  if (to) lineFetch_('https://api.line.me/v2/bot/message/push', { to: to, messages: msgs });
}

/** 解析待ち表示。1対1はローディングアニメ(返信枠を温存)、グループは返信 */
function startWait_(ev, msg) {
  if (ev.source.type === 'user' && ev.source.userId) {
    lineFetch_('https://api.line.me/v2/bot/chat/loading/start', { chatId: ev.source.userId, loadingSeconds: 60 });
  } else {
    send_(ev, text_(msg));
  }
}

function fetchLineContent_(messageId) {
  const res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('画像を取得できませんでした(' + res.getResponseCode() + ')');
  return res.getBlob();
}

/* ============================== Gemini ============================== */

const RECIPE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_recipe: { type: 'BOOLEAN' },
    title: { type: 'STRING' },
    servings: { type: 'STRING' },
    ingredients: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, amount: { type: 'STRING' }, tag: { type: 'STRING' } },
        required: ['name', 'amount', 'tag'],
      },
    },
    steps: { type: 'ARRAY', items: { type: 'STRING' } },
    memo: { type: 'STRING' },
  },
  required: ['is_recipe', 'title', 'servings', 'ingredients', 'steps', 'memo'],
};

const PROMPT_COMMON = [
  '料理のレシピ情報を抽出し、指定のJSON形式で日本語で出力してください。',
  '- 料理のレシピとして読み取れない場合は is_recipe を false にし、他は空にする。',
  '- title: 料理名。',
  '- servings: 何人分か(例: "2人分")。不明なら空文字。',
  '- ingredients: 材料。name は一般的な表記(例: 玉ねぎ、鶏もも肉、しょうゆ)。amount は分量(例: "2個", "大さじ1")。不明なら "適量" か空文字。',
  '  tag は検索用の大まかな食材名(例: 鶏もも肉→鶏肉、長ねぎ→ねぎ、豚バラ薄切り肉→豚肉)。分類できなければ name と同じにする。',
  '- steps: 作り方を順番に。1工程は1〜2文で簡潔に。番号は付けない。',
  '- memo: コツ・ポイントがあれば短く。なければ空文字。',
  '- 情報にないことを推測で補わない。',
].join('\n');

function geminiModels_() {
  const l = prop_('GEMINI_MODELS') || prop_('GEMINI_MODEL') || 'gemini-flash-latest,gemini-flash-lite-latest';
  return l.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
function listProp_(key, def) {
  return (prop_(key) || def).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

const JSON_TAIL = '\n\n出力はJSONのみ(説明文やコードブロックは不要)。形式: ' +
  '{"is_recipe":true,"title":"","servings":"","ingredients":[{"name":"","amount":"","tag":""}],"steps":[""],"memo":""}';

function analyzeYouTube_(url) {
  // YouTube URLを直接読めるのはGeminiのみ。モデルを順に試す
  const parts = [
    { file_data: { file_uri: url } },
    { text: PROMPT_COMMON + '\n\nこの動画で作っている料理について、映像・音声・字幕・概要欄からレシピを抽出してください。' },
  ];
  return chain_(geminiModels_().map(function (m) {
    return { name: 'gemini:' + m, fn: function () { return callGemini_(m, parts); } };
  }));
}

function analyzeImages_(blobs) {
  const imgs = blobs.map(function (b) {
    return { mime: b.getContentType() || 'image/jpeg', b64: Utilities.base64Encode(b.getBytes()) };
  });
  const task = imgs.length > 1
    ? '\n\nこれらの' + imgs.length + '枚の画像は、同じ1つのレシピの一部です(材料のページ、作り方のページなど)。送られた順に並んでいます。全体を統合して1つのレシピにしてください。重複する内容は1つにまとめてください。'
    : '\n\nこの画像(料理写真、またはレシピのスクリーンショット/本のページ/手書きメモ)からレシピを抽出してください。文字が読める場合はその内容を優先し、写真のみの場合は見た目から推定できる範囲にとどめてください。';
  const prompt = PROMPT_COMMON + task;
  const attempts = [];
  listProp_('IMAGE_PROVIDERS', 'gemini,groq,openrouter').forEach(function (p) {
    if (p === 'gemini' && prop_('GEMINI_API_KEY')) {
      const parts = imgs.map(function (i) { return { inline_data: { mime_type: i.mime, data: i.b64 } }; }).concat([{ text: prompt }]);
      geminiModels_().forEach(function (m) {
        attempts.push({ name: 'gemini:' + m, fn: function () { return callGemini_(m, parts); } });
      });
    } else if (p === 'groq' && prop_('GROQ_API_KEY')) {
      listProp_('GROQ_MODELS', 'meta-llama/llama-4-scout-17b-16e-instruct').forEach(function (m) {
        attempts.push({
          name: 'groq:' + m, fn: function () {
            if (imgs.some(function (i) { return i.b64.length > 3.5e6; })) throw new Error('TOO_BIG'); // Groqはbase64画像のサイズ上限が小さいため保険
            return callOpenAiCompat_('https://api.groq.com/openai/v1/chat/completions', prop_('GROQ_API_KEY'), m, prompt + JSON_TAIL, imgs);
          },
        });
      });
    } else if (p === 'openrouter' && prop_('OPENROUTER_API_KEY')) {
      listProp_('OPENROUTER_MODELS', 'openrouter/free').forEach(function (m) {
        attempts.push({
          name: 'openrouter:' + m, fn: function () {
            return callOpenAiCompat_('https://openrouter.ai/api/v1/chat/completions', prop_('OPENROUTER_API_KEY'), m, prompt + JSON_TAIL, imgs);
          },
        });
      });
    }
  });
  if (!attempts.length) throw new Error('解析用のAPIキーが設定されていません');
  return chain_(attempts);
}

/** 上から順に試し、無料枠切れ(429)や失敗なら次へ。直近で枠切れした先は5分スキップ */
function chain_(attempts) {
  const cache = CacheService.getScriptCache();
  const live = attempts.filter(function (a) { return !cache.get('cool_' + a.name); });
  const order = live.length ? live : attempts;
  let lastErr = null, quotaCount = 0;
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    try {
      const d = a.fn();
      d.via = a.name;
      console.log('analyzed by ' + a.name);
      return d;
    } catch (e) {
      const m = String(e.message || e);
      if (m === 'NOT_RECIPE') throw e;
      if (m === 'QUOTA') { quotaCount++; cache.put('cool_' + a.name, '1', 300); }
      console.warn(a.name + ' failed: ' + m.slice(0, 200));
      lastErr = e;
    }
  }
  if (quotaCount === order.length) throw new Error('QUOTA');
  throw lastErr;
}

function callGemini_(model, parts) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が未設定です');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const payload = {
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: RECIPE_SCHEMA, temperature: 0.2 },
  };
  let res, code;
  for (let attempt = 1; attempt <= 2; attempt++) {
    res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    code = res.getResponseCode();
    if (code !== 503 && code !== 500) break;
    Utilities.sleep(2000 * attempt);
  }
  if (code === 429) throw new Error('QUOTA');
  if (code !== 200) throw new Error('Gemini error ' + code + ': ' + res.getContentText().slice(0, 300));
  const json = JSON.parse(res.getContentText());
  const cand = json.candidates && json.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) throw new Error('BLOCKED');
  return toRecipe_(JSON.parse(cand.content.parts.map(function (p) { return p.text || ''; }).join('')));
}

/** Groq / OpenRouter (OpenAI互換API)で画像を解析 */
function callOpenAiCompat_(url, key, model, prompt, imgs) {
  const payload = {
    model: model, temperature: 0.2,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }].concat(imgs.map(function (i) {
      return { type: 'image_url', image_url: { url: 'data:' + i.mime + ';base64,' + i.b64 } };
    })) }],
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 429) throw new Error('QUOTA');
  if (code !== 200) throw new Error(model + ' error ' + code + ': ' + res.getContentText().slice(0, 300));
  const json = JSON.parse(res.getContentText());
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('empty response');
  return toRecipe_(parseJsonLoose_(content));
}

function parseJsonLoose_(s) {
  const t = String(s).replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('JSONを解釈できませんでした');
  return JSON.parse(t.slice(a, b + 1));
}

function toRecipe_(obj) {
  if (!obj.is_recipe) throw new Error('NOT_RECIPE');
  return {
    title: String(obj.title || '').trim(),
    servings: String(obj.servings || '').trim(),
    ingredients: (obj.ingredients || []).map(function (i) {
      return { name: String(i.name || '').trim(), amount: String(i.amount || '').trim(), tag: String(i.tag || '').trim() };
    }).filter(function (i) { return i.name; }),
    steps: (obj.steps || []).map(function (s) { return String(s).trim(); }).filter(Boolean),
    memo: String(obj.memo || '').trim(),
  };
}

function friendlyError_(err) {
  const m = String(err.message || err);
  if (m === 'NOT_RECIPE') return 'レシピとして読み取れませんでした。\n動画の場合は「公開」設定か、料理動画かをご確認ください。画像は文字がはっきり写っているものだと精度が上がります。';
  if (m === 'QUOTA') return '設定している解析サービスの無料枠がすべて上限に達しました。少し時間をおいてからもう一度お試しください。';
  if (m === 'TOO_BIG') return '画像の合計サイズが大きすぎます。枚数を減らすか、小さい画像でやり直してください。';
  if (m === 'BLOCKED') return '解析できませんでした(動画が非公開、または年齢制限などの可能性があります)。';
  return '解析に失敗しました。\n' + m.slice(0, 200);
}

function extractYouTubeId_(t) {
  const m = t.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s]*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function youTubeTitle_(url) {
  try {
    const res = UrlFetchApp.fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) return String(JSON.parse(res.getContentText()).title || '');
  } catch (e) { /* noop */ }
  return '';
}

/* ============================== LIFF 用 API ============================== */

function verifyIdToken_(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post', payload: { id_token: idToken, client_id: prop_('LIFF_CHANNEL_ID') }, muteHttpExceptions: true,
  });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null;
}

function handleApi_(b) {
  const user = verifyIdToken_(b.idToken);
  if (!user) return jsonOut_({ ok: false, error: '認証に失敗しました。LINEから開き直してください。' });
  if (!isAllowedSource_({ userId: user.sub })) return jsonOut_({ ok: false, error: 'このアカウントは利用できません。' });

  const id = String(b.id || '');
  switch (b.action) {
    case 'get': {
      const r = getRecipe_(id);
      if (!r) return jsonOut_({ ok: false, error: 'レシピが見つかりません(破棄または削除済みかもしれません)。' });
      return jsonOut_({ ok: true, recipe: publicRecipe_(r) });
    }
    case 'save': {
      const clean = sanitize_(b.recipe || {});
      if (!clean.title) return jsonOut_({ ok: false, error: '料理名を入力してください。' });
      clean.status = 'confirmed';
      const r = updateRecipe_(id, clean);
      if (!r) return jsonOut_({ ok: false, error: 'レシピが見つかりません。' });
      return jsonOut_({ ok: true, recipe: publicRecipe_(r) });
    }
    case 'delete': {
      deleteRecipe_(id);
      return jsonOut_({ ok: true });
    }
    default:
      return jsonOut_({ ok: false, error: 'unknown action' });
  }
}

function publicRecipe_(r) {
  return {
    id: r.id, status: r.status, title: r.title, servings: r.servings, ingredients: r.ingredients,
    steps: r.steps, memo: r.memo, source_type: r.source_type, source_url: r.source_url,
  };
}

function sanitize_(x) {
  const s = function (v, n) { return String(v == null ? '' : v).trim().slice(0, n); };
  return {
    title: s(x.title, 100),
    servings: s(x.servings, 30),
    ingredients: (Array.isArray(x.ingredients) ? x.ingredients : []).slice(0, 60).map(function (i) {
      return { name: s(i.name, 50), amount: s(i.amount, 40), tag: s(i.tag, 50) };
    }).filter(function (i) { return i.name; }),
    steps: (Array.isArray(x.steps) ? x.steps : []).slice(0, 60).map(function (v) { return s(v, 500); }).filter(Boolean),
    memo: s(x.memo, 1000),
  };
}

/* ============================== スプレッドシート(DB) ============================== */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@'); // 全列テキスト扱い
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues().map(function (row, i) { return rowToObj_(row, i + 2); });
}

function parseJson_(v, fallback) {
  try { const x = JSON.parse(v); return x == null ? fallback : x; } catch (e) { return fallback; }
}

function rowToObj_(row, rowNum) {
  const o = { _row: rowNum };
  HEADERS.forEach(function (h, i) { o[h] = row[i]; });
  o.id = String(o.id);
  o.ingredients = parseJson_(o.ingredients, []);
  o.steps = parseJson_(o.steps, []);
  return o;
}

function objToRow_(r) {
  return HEADERS.map(function (h) {
    if (h === 'ingredients' || h === 'steps') return JSON.stringify(r[h] || []);
    return r[h] == null ? '' : r[h];
  });
}

function buildIndex_(ingredients) {
  const set = [];
  (ingredients || []).forEach(function (i) {
    [i.name, i.tag].forEach(function (v) { if (v && set.indexOf(v) < 0) set.push(v); });
  });
  return set.join('|');
}

function findRow_(id) {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2 || !id) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function getRecipe_(id) {
  const n = findRow_(id);
  return n ? rowToObj_(sheet_().getRange(n, 1, 1, HEADERS.length).getValues()[0], n) : null;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function saveNew_(fields) {
  return withLock_(function () {
    const now = new Date().toISOString();
    const r = Object.assign({
      id: Utilities.getUuid().replace(/-/g, '').slice(0, 8), status: 'draft', title: '', servings: '',
      ingredients: [], steps: [], source_type: 'manual', source_url: '', memo: '', created_by: '',
      created_at: now, updated_at: now,
    }, fields);
    r.ingredient_index = buildIndex_(r.ingredients);
    sheet_().appendRow(objToRow_(r));
    return r;
  });
}

function updateRecipe_(id, fields) {
  return withLock_(function () {
    const cur = getRecipe_(id);
    if (!cur) return null;
    const r = Object.assign(cur, fields, { updated_at: new Date().toISOString() });
    r.ingredient_index = buildIndex_(r.ingredients);
    sheet_().getRange(cur._row, 1, 1, HEADERS.length).setValues([objToRow_(r)]);
    return r;
  });
}

function deleteRecipe_(id) {
  withLock_(function () {
    const n = findRow_(id);
    if (n) sheet_().deleteRow(n);
  });
}

function parseQuery_(s) {
  const o = {};
  String(s || '').split('&').forEach(function (kv) {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  return o;
}
