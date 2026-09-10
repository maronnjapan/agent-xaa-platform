import type { Element } from '../element.js';

export const GUIDE_LEAD = 'ToDo を書く、権限を承認する、Agent が実行する、完了にする。この順に進みます。';

/**
 * How to work the site, on the site.
 *
 * The home screen numbers its own sections, so this page does not repeat what the
 * buttons say. It carries what the buttons cannot: what a step commits the person to,
 * and which steps cannot be taken back. Confirming a ToDo, approving a permission set,
 * stopping an agent and withdrawing a ToDo are all one-way, and a person who learns
 * that from the screen after pressing the button has learnt it too late.
 *
 * Every line here is either what to press or what it costs. It names no capability and
 * no isolation level, not even as an example. This app does not know what those strings
 * mean (RULE-07), and a guide that illustrated one would be the first place the
 * vocabulary crept back in.
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
        <h2>1. ToDo を書く</h2>
        <p><a href="/">ToDo</a>の「1. ToDo を書く」に書いて、「ToDo を登録する」を押します。</p>
        <p>タイトルは必須です。説明には何をしてほしいかを、実行時のコンテキストには AI が作業中に持っていてほしい背景や前提、資料の場所を書きます。</p>
        <p>完了条件には、何ができたら終わりかを1行に1つ書きます。AI はこれを満たしたら作業を終えます。</p>
        <p>手順と注意点も1行に1つ。手順は任せてよければ空で構いません。優先度と期限は一覧の並び順に使われ、AI にも伝わります。</p>
        <p>動かしておきたい時間は分で、1分から1440分（24時間）までです。</p>
        <p>権限は書きません。書いた内容から決まります。</p>
        <p>内容が決まっていないときは、同じ画面の上の「ToDo の候補を探す」で候補を挙げてもらえます。</p>
        <p>登録した ToDo は「2. ToDo 一覧」に「下書き」として並びます。「書き直してもらう」は AI が文面を直すだけで、「自分で書き直す」を開けば自分で直せます。どちらも確定はしません。</p>
      </section>

      <section className="card" data-step="confirm">
        <h2>2. 内容を確定する</h2>
        <p>「この内容で確定する」を押すと ToDo は「実行待ち」になり、内容は書き換えられなくなります。</p>
        <p>まだやらせないと決めたら「取り下げる」で閉じます。取り下げた ToDo は元に戻せません。</p>
      </section>

      <section className="card" data-step="decide">
        <h2>3. 必要な権限を調べる</h2>
        <p>「必要な権限を調べる」を押すと、許可される操作と隔離のレベルが出ます。</p>
      </section>

      <section className="card" data-step="approve">
        <h2>4. 承認して Agent を作る</h2>
        <p>提示された内容を読み、「この権限で承認する」、続けて「この内容で Agent を作る」を押すと Agent ができます。</p>
        <p>Agent には、確定した ToDo の内容（タイトル、説明、コンテキスト、完了条件、手順、注意点、優先度、期限）が1件目の指示として渡ります。渡るのは文章だけで、承認した権限は変わりません。</p>
        <p>承認したあとに必要な権限が変わっていた場合、作成は断られます。提示され直した内容を読んで、承認からやり直します。</p>
        <p>Agent ができると ToDo は「実行中」になり、カードにその Agent へのリンクと状態が出ます。</p>
      </section>

      <section className="card" data-step="operate">
        <h2>5. 動かして、見て、止める</h2>
        <p>Agent の画面は ToDo のカードのリンクか、<a href="/">ToDo</a>の「3. 動き出した Agent」から開きます。いまの状態、残り時間、使った Tool が出ます。</p>
        <p>「実行ログ」には1手ごとの中身が出ます。動いている最中でも読めます。</p>
        <p>「指示を追加する」で追加の指示を送れます。承認した権限の外の操作は、指示しても実行されません。</p>
        <p>「この Agent を止める」で即座に止まります。止めた Agent は元に戻せません。</p>
        <p>起きたことは<a href="/activity">アクティビティ</a>で見ます。Agent ごとに1枚のカードになり、「準備」「作業 1」「終了」の区切りで、できごとが起きた順に並びます。区切りを開くと、できごとの一覧と、その動きを図で再生するところが出ます。</p>
        <p>カードの頭の「流れを通しで見る」を押すと、まず図に出てくる登場人物を1つずつ紹介し、そのあとログインから終了までの区切りをつないで、1つの図で通して再生します。人に見せるときはこちらが向いています。「速く」で1手が半分の長さになり、「全画面で見る」で画面いっぱいに出せます。</p>
        <p>Agent の挙動はログを分析するエージェントが見ています。その判断は上の「分析エージェントの判断」で読めます。別のサイトなので、初回はもう一度ログインを求められます。</p>
      </section>

      <section className="card" data-step="monitor">
        <h2>ログ分析の判断を確かめる</h2>
        <p><a href="/security">ログ分析モニター</a>には、ログを分析するエージェントがどこまで進み、何を根拠に AI を起動し、どう対応を決めたかが出ます。自分に関わる最新30件を5秒ごとに読み直します。</p>
        <p>デモ環境では Agent の画面に「異常系を試す」が出ます。動いている Agent の実行をわざと失敗させ、状況確認、実行ログ、アクティビティにどう現れるかを確かめられます。</p>
      </section>

      <section className="card" data-step="close">
        <h2>6. 完了にする</h2>
        <p>Agent が作業を終えると、ToDo のカードにその結果（最後まで行った、権限の外で止まった、途中で問題が起きた）が出ます。</p>
        <p>結果を読んで、済んだと判断したら「完了にする」を押します。ToDo を閉じるのは Agent ではなく、あなたです。</p>
        <p>Agent が動いている間は取り下げられません。先に Agent の画面で止めてから「取り下げる」を押します。</p>
        <p>完了と取り下げは元に戻せません。同じ ToDo をもう一度やらせるには、新しく書きます。</p>
      </section>

      <section className="card" data-step="api">
        <h2>他のツールから ToDo を登録する</h2>
        <p>ToDo は外部からも登録できます。Human IdP が発行した、この画面宛のアクセストークンを付けて <code>POST /external/todos</code> を呼びます。</p>
        <p>登録できるのは下書きまでです。確定、承認、Agent の作成はこの画面で行います。手順は設計書の[02. §6](https://github.com/maronnjapan/agent-xaa-platform/blob/main/docs/02-automation-design.md)にあります。</p>
      </section>

      <section className="card" data-step="notes">
        <h2>先に知っておくこと</h2>
        <ul>
          <li>権限は自分で選びません。書いた ToDo の内容から決まり、承認するかどうかだけを選びます。</li>
          <li>作った Agent の権限は、あとから増やせません。足りなければ ToDo を書くところからやり直します。</li>
          <li>Agent は長くても24時間で消えます。同じ ToDo をさせるには、もう一度作ります。</li>
          <li>ToDo を完了にしても Agent は止まりません。止めるのは Agent の画面です。</li>
        </ul>
      </section>

      <section className="card" data-step="trouble">
        <h2>思ったとおりに動かないとき</h2>
        <dl>
          <dt>Agent が操作を断られた</dt>
          <dd>承認した権限の外でした。ToDo を書き直して、新しい Agent を作ってください。</dd>
          <dt>「この内容で Agent を作る」が断られた</dt>
          <dd>承認したあとに必要な権限が変わっています。承認からやり直してください。</dd>
          <dt>「取り下げる」が断られた</dt>
          <dd>Agent がまだ動いています。Agent の画面で止めてから、もう一度押してください。</dd>
          <dt>アクティビティに何も出ない</dt>
          <dd>中身が出るのは終わった区切りだけです。動いている最中のものは「実行中」とだけ出るので、Agent の画面の「実行ログ」で見てください。</dd>
          <dt>どこで止められたのか知りたい</dt>
          <dd>アクティビティの上にある「遮断されたものだけ」を押すと、止められたできごとだけが残ります。</dd>
          <dt>図の動きが速くて追えない</dt>
          <dd>「一時停止」で止まり、「次へ」で1手ずつ進みます。できごとの一覧はいつでも読めます。</dd>
          <dt>箱の名前が分からない</dt>
          <dd>アクティビティの「この記録に出てくるもの」を開くか、図の箱を押してください。</dd>
          <dt>Agent が急に隔離された</dt>
          <dd>ログを分析するエージェントが異常と判断しました。何をどう判断したかは上の「分析エージェントの判断」に出ます。</dd>
        </dl>
      </section>
    </main>
  );
}
