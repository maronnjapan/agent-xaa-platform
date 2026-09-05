import type { Element } from '../element.js';

export const GUIDE_LEAD = '作業を書くところから Agent を止めるところまで、この順に進みます。';

/**
 * How to work the site, on the site.
 *
 * The home screen numbers its own sections, so this page does not repeat what the
 * buttons say. It carries what the buttons cannot: what a step commits the person to,
 * and which steps cannot be taken back. Confirming a draft, approving a permission set
 * and stopping an agent are all one-way, and a person who learns that from the screen
 * after pressing the button has learnt it too late.
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
    <main class="guide" data-page="guide">
      <h1>使い方</h1>
      <p class="lead">{GUIDE_LEAD}</p>

      <section class="card" data-step="describe">
        <h2>1. 自動化したい作業を書く</h2>
        <p><a href="/">自動化をつくる</a>の「1. 自動化したい作業を書く」に、目的と説明、手順、確認したいこと、注意点、動かしておきたい時間を書きます。</p>
        <p>手順と確認したいことと注意点は、1行に1つ書きます。動かしておきたい時間は最大24時間です。</p>
        <p>何を書くか決まっていないときは、同じ画面の上にある「自動化できそうな作業を探す」で、記録に残っている作業から候補を挙げてもらえます。</p>
        <p>Agent に何を許可するかは書きません。書いた作業内容から決まります。</p>
      </section>

      <section class="card" data-step="confirm">
        <h2>2. 内容を確定する</h2>
        <p>保存した作業は「2. 内容を確定し、提示された権限を承認する」に並びます。</p>
        <p>直したいところは「書き直してもらう」に文章で伝えると、書き直した案が返ります。これは文面を書き換えるだけで、確定させる操作ではありません。</p>
        <p>納得できたら「この内容で確定する」を押します。確定した作業内容は、あとから書き換えられません。</p>
      </section>

      <section class="card" data-step="decide">
        <h2>3. 必要な権限を調べる</h2>
        <p>「必要な権限を調べる」を押すと、その作業に何が必要かが決まり、Agent Definition として提示されます。</p>
        <p>許可される操作の一覧と、隔離のレベルが出ます。</p>
      </section>

      <section class="card" data-step="approve">
        <h2>4. 承認して Agent を作る</h2>
        <p>提示された内容を読んでから「この権限で承認する」を押します。承認するまで Agent は作られません。</p>
        <p>続けて「この内容で Agent を作る」を押すと Agent ができ、その Agent の画面へ移ります。</p>
        <p>承認したあとに必要な権限が変わっていた場合、作成は断られます。提示され直した内容を読んで、承認からやり直してください。</p>
      </section>

      <section class="card" data-step="operate">
        <h2>5. 動かして、見て、止める</h2>
        <p>Agent の画面には、いまの状態、残り時間、使った Tool とその結果が出ます。あとから開くときは、<a href="/">自動化をつくる</a>の「3. 動き出した Agent」から入ります。</p>
        <p>同じ画面の「実行ログ」には、Agent が1手ごとに何を選び、どこへ何を送り、何が返り、送る前に何を確かめたかが出ます。Agent 自身が書いた文章もそのまま載ります。動いている最中でも読めます。</p>
        <p>追加で伝えたいことは「指示を追加する」で足せます。承認した権限の外の操作は、指示しても実行されません。</p>
        <p>「この Agent を止める」で即座に止まります。止めた Agent は元に戻せません。</p>
        <p>終わった処理の流れは<a href="/activity">タイムライン</a>で見られます。図の再生と、起きたことの一覧の両方が出ます。動いている最中のものは Agent の画面で見てください。</p>
      </section>

      <section class="card" data-step="notes">
        <h2>先に知っておくこと</h2>
        <ul>
          <li>権限は自分で選びません。書いた作業内容から決まり、承認するかどうかだけを選びます。</li>
          <li>作った Agent の権限は、あとから増やせません。足りなければ作業を書くところからやり直します。</li>
          <li>Agent は長くても24時間で消えます。消えたあとに同じ作業をさせるには、もう一度作ります。</li>
        </ul>
      </section>

      <section class="card" data-step="trouble">
        <h2>思ったとおりに動かないとき</h2>
        <dl>
          <dt>Agent が操作を断られた</dt>
          <dd>承認した権限の外だったということです。作業内容を書き直して、新しい Agent を作ってください。</dd>
          <dt>「この内容で Agent を作る」が断られた</dt>
          <dd>承認したあとに必要な権限が変わっています。提示されている内容を読み直して、承認からやり直してください。</dd>
          <dt>タイムラインに何も出ない</dt>
          <dd>終わった処理だけを再生します。動いている最中のものは Agent の画面の「実行ログ」で見てください。</dd>
          <dt>図の動きが速くて追えない</dt>
          <dd>再生の上にある「一時停止」で止まり、「次へ」で1つずつ進みます。止めた状態でも、下の一覧はいつでも読めます。</dd>
        </dl>
      </section>
    </main>
  );
}
