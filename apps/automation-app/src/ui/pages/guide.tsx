import type { Element } from '../element.js';

export const GUIDE_LEAD = '作業を書く、権限を承認する、Agent が動く。この順に進みます。';

/**
 * How to work the site, on the site.
 *
 * The home screen numbers its own sections, so this page does not repeat what the
 * buttons say. It carries what the buttons cannot: what a step commits the person to,
 * and which steps cannot be taken back. Confirming a draft, approving a permission set
 * and stopping an agent are all one-way, and a person who learns that from the screen
 * after pressing the button has learnt it too late.
 *
 * Every line here is either what to press or what it costs. It used to explain the
 * timeline's diagram, its panel and its log in three paragraphs of prose, which is the
 * screen describing a screen the reader is not looking at — that belongs beside the
 * picture, where the legend is, and it has been cut back to here.
 *
 * It names no capability and no isolation level, not even as an example. This app does
 * not know what those strings mean (RULE-07), and a guide that illustrated one would be
 * the first place the vocabulary crept back in.
 *
 * Each paragraph is one line of source, because JSX joins wrapped text with a space and
 * a space inside a Japanese sentence is visible.
 */
export function GuidePage(): Element {
  return (
    <main className="guide" data-page="guide">
      <h1>使い方</h1>
      <p className="lead">{GUIDE_LEAD}</p>

      <section className="card" data-step="describe">
        <h2>1. 自動化したい作業を書く</h2>
        <p><a href="/">自動化をつくる</a>の「1. 自動化したい作業を書く」に書いて、「下書きを保存する」を押します。</p>
        <p>手順・確認したいこと・注意点は1行に1つ。動かしておきたい時間は分で、1分から1440分（24時間）までです。</p>
        <p>権限は書きません。書いた作業内容から決まります。</p>
        <p>内容が決まっていないときは、同じ画面の上の「自動化できそうな作業を探す」で候補を挙げてもらえます。</p>
      </section>

      <section className="card" data-step="confirm">
        <h2>2. 内容を確定する</h2>
        <p>保存した作業は「2. 内容を確定し、提示された権限を承認する」に並びます。</p>
        <p>「書き直してもらう」は文面を直すだけです。確定はしません。</p>
        <p>「この内容で確定する」を押すと、作業内容は書き換えられなくなります。</p>
      </section>

      <section className="card" data-step="decide">
        <h2>3. 必要な権限を調べる</h2>
        <p>「必要な権限を調べる」を押すと、許可される操作と隔離のレベルが出ます。</p>
      </section>

      <section className="card" data-step="approve">
        <h2>4. 承認して Agent を作る</h2>
        <p>提示された内容を読み、「この権限で承認する」、続けて「この内容で Agent を作る」を押すと Agent ができます。</p>
        <p>承認したあとに必要な権限が変わっていた場合、作成は断られます。提示され直した内容を読んで、承認からやり直します。</p>
      </section>

      <section className="card" data-step="operate">
        <h2>5. 動かして、見て、止める</h2>
        <p>Agent の画面は<a href="/">自動化をつくる</a>の「3. 動き出した Agent」から開きます。いまの状態、残り時間、使った Tool が出ます。</p>
        <p>「実行ログ」には1手ごとの中身が出ます。動いている最中でも読めます。</p>
        <p>「指示を追加する」で追加の指示を送れます。承認した権限の外の操作は、指示しても実行されません。</p>
        <p>「この Agent を止める」で即座に止まります。止めた Agent は元に戻せません。</p>
        <p>終わった処理は<a href="/activity">タイムライン</a>で見ます。Agent ごとに、動きの再生が並び、そのあとに「やったこと」が続きます。</p>
        <p>Agent の挙動はログを分析するエージェントが見ています。その判断は上の「分析エージェントの判断」で読めます。別のサイトなので、初回はもう一度ログインを求められます。</p>
      </section>

      <section className="card" data-step="notes">
        <h2>先に知っておくこと</h2>
        <ul>
          <li>権限は自分で選びません。書いた作業内容から決まり、承認するかどうかだけを選びます。</li>
          <li>作った Agent の権限は、あとから増やせません。足りなければ作業を書くところからやり直します。</li>
          <li>Agent は長くても24時間で消えます。同じ作業をさせるには、もう一度作ります。</li>
        </ul>
      </section>

      <section className="card" data-step="trouble">
        <h2>思ったとおりに動かないとき</h2>
        <dl>
          <dt>Agent が操作を断られた</dt>
          <dd>承認した権限の外でした。作業内容を書き直して、新しい Agent を作ってください。</dd>
          <dt>「この内容で Agent を作る」が断られた</dt>
          <dd>承認したあとに必要な権限が変わっています。承認からやり直してください。</dd>
          <dt>タイムラインに何も出ない</dt>
          <dd>再生できるのは終わった処理だけです。動いている最中のものは Agent の画面の「実行ログ」で見てください。</dd>
          <dt>図の動きが速くて追えない</dt>
          <dd>「一時停止」で止まり、「次へ」で1手ずつ進みます。「やったこと」はいつでも読めます。</dd>
          <dt>箱の名前が分からない</dt>
          <dd>タイムラインの先頭の「この記録に出てくるもの」を開くか、図の箱を押してください。</dd>
          <dt>Agent が急に隔離された</dt>
          <dd>ログを分析するエージェントが異常と判断しました。何をどう判断したかは上の「分析エージェントの判断」に出ます。</dd>
        </dl>
      </section>
    </main>
  );
}
