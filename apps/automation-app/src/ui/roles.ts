/**
 * Who is who on this platform, written down once.
 *
 * A person watching a replay sees eight boxes exchanging dots, and a written log whose
 * every line begins with a name — `agent-runtime`, `resource-as`, `agent-op`. Without
 * somewhere that says what those are, the screen is a diagram of a system the reader
 * has to already know. That was the complaint: 「それぞれのアプリって何をしているか
 * 全然わからない」.
 *
 * So each part gets five fixed strings: what it is called, the one phrase that goes
 * inside its box, what it is like in everyday terms, what it does, and what it
 * deliberately does not do. The last one carries most of the weight — this platform's
 * whole point is that the thing which decides is not the thing which acts, and a
 * reader who does not know that cannot see why an arrow stopping short matters. The
 * everyday likeness is for the person meeting the picture for the first time: 「審査係」
 * says in one word what 「権限決定」 takes a paragraph to say.
 *
 * These are screen furniture, not an interpretation of any event (RULE-54). They say
 * the same words on every replay of every task, they are written from docs 05, and no
 * value from an Activity Event reaches them. The distinction that matters is: a
 * renderer may say what the Resource AS *is*, and may never say what it *did* — the
 * second sentence belongs to the publisher, and arrives on the event.
 */

/** Where a part sits in the story, which is also which row of the diagram it is on. */
export type RoleLane = 'person' | 'control' | 'agent' | 'resource' | 'watch';

export interface ActorRole {
  /** The `source` an Activity Event carries, and the diagram node's id. */
  id: string;
  /**
   * The formal name, as docs 05 and the Analysis Console spell it. Kept beside the
   * Japanese one so a reader can match the screen against a document or a log.
   */
  label: string;
  /** What the screen calls the part: short enough for a box, plain enough to read. */
  name: string;
  /** The one phrase inside the box. Short enough to sit under the name. */
  role: string;
  /**
   * What the part is like in everyday terms — a counter, a clerk, a vault. Said when a
   * part is introduced and beside its name on its card, never in the box itself.
   */
  analogy: string;
  lane: RoleLane;
  /** What it does, in the reader's terms. */
  does: string;
  /** What it does not do — the half that explains why the platform is shaped this way. */
  doesNot: string;
}

export const LANE_LABELS: Readonly<Record<RoleLane, string>> = {
  person: '人',
  control: '決める側',
  agent: '動く側',
  resource: 'データを持つ側',
  watch: '見張る側',
};

/**
 * The order is the order of the story, not the order of the diagram: a person writes
 * the work, the platform decides what it may do, an agent is made, the agent acts, the
 * resources answer, and two more parts watch the whole of it from outside.
 */
export const ACTOR_ROLES: readonly ActorRole[] = [
  {
    id: 'human-user',
    label: '利用者',
    name: '利用者',
    role: '指示する人',
    analogy: '依頼主',
    lane: 'person',
    does: '自動化したい作業を言葉で書き、提示された権限を読んで承認する。Agent を止めるのもここ。',
    doesNot: '権限を自分で選ばない。何が必要かは書いた作業から決まる。',
  },
  {
    id: 'automation-app',
    label: 'Automation App',
    name: 'ToDo の画面',
    role: '画面と記録',
    analogy: '受付',
    lane: 'control',
    does: 'いま見ているこの画面。作業の下書きを預かり、権限の承認を受け取り、起きたことを時系列で見せる。',
    doesNot: '権限を決めない。Agent を直接作らない。Agent の代わりにリソースを触らない。',
  },
  {
    id: 'authorization-platform',
    label: 'Authorization Platform',
    name: '権限決定',
    role: '権限を決める',
    analogy: '審査係',
    lane: 'control',
    does: '書かれた作業を読み、その作業に要る権限を決める。AI が候補を挙げ、Policy Engine が可否を出す。',
    doesNot: '決めた権限を自分では使わない。人の承認なしに Agent を作らせない。',
  },
  {
    id: 'agent-provisioner',
    label: 'Agent Provisioner',
    name: 'Agent 作成',
    role: 'Agent を作る',
    analogy: '手配係',
    lane: 'control',
    does: '承認された権限のとおりに Agent を1体だけ登録し、使えるツールと有効期限を固定して動かす。',
    doesNot: '権限を足さない。作ったあとで許可を書き換えない。',
  },
  {
    id: 'agent-op',
    label: 'Agent OP',
    name: 'Agent の身元発行',
    role: '身元を発行する',
    analogy: '身分証の窓口',
    lane: 'agent',
    does: 'その Agent が誰の代理で何をしてよいかを示す証（ID-JAG）を、要求のたびに発行する。',
    doesNot: 'データを持たない。何を許すかを決めない。決まっていることを証明するだけ。',
  },
  {
    id: 'agent-runtime',
    label: 'Agent Runtime',
    name: 'Agent 実行環境',
    role: 'Agent が動く場所',
    analogy: 'Agent の作業場',
    lane: 'agent',
    does: 'AI が1手ずつ考え、使うツールを選び、実行する。送る前に、許可・有効期限・人が付けた条件を自分で確かめる。',
    doesNot: '許可されていないツールを送らない。自分の権限を広げられない。',
  },
  {
    id: 'resource-as',
    label: 'Resource AS',
    name: 'リソース認可',
    role: 'Access Token を出す',
    analogy: '入場券の窓口',
    lane: 'resource',
    does: 'Agent OP が出した証を受け取り、そのリソースに対してだけ使える Access Token に引き換える。',
    doesNot: '証の範囲を超えた Token を出さない。人の代わりに承認しない。',
  },
  {
    id: 'resource-api',
    label: 'Resource API',
    name: 'リソース API',
    role: 'データを持つ',
    analogy: 'データの保管庫',
    lane: 'resource',
    does: '文書や支払いの実体を持ち、Access Token に書かれた範囲だけ読み書きさせる。',
    doesNot: 'Token が無い要求に答えない。誰の代理かを推測しない。',
  },
  {
    id: 'lifecycle-manager',
    label: 'Lifecycle Manager',
    name: '終了管理',
    role: 'Agent を終わらせる',
    analogy: '時間を見る係',
    lane: 'watch',
    does: '有効期限が来た Agent と、止められた Agent を確実に終了させる。',
    doesNot: 'Agent と会話しない。実行中の処理に割り込まない。',
  },
  {
    id: 'security-detection',
    label: 'Security Detection',
    name: '不正検知',
    role: 'おかしな動きを見つける',
    analogy: '見回り',
    lane: 'watch',
    does: '各アプリが出した記録をあとから突き合わせ、規約違反や不正利用の兆候を見つける。',
    doesNot: '実行を止めない。止めるのは、実行するその場にいる側の仕事。',
  },
];

const BY_ID: ReadonlyMap<string, ActorRole> = new Map(ACTOR_ROLES.map((actor) => [actor.id, actor]));

/**
 * Two publishers spell their own name differently from the box they belong to
 * (`authorization`, `provisioner`), which is why the replay already keeps a map from
 * `source` to node id. The same aliases are honoured here so the log and the diagram
 * name a part identically.
 */
const ALIASES: Readonly<Record<string, string>> = {
  authorization: 'authorization-platform',
  provisioner: 'agent-provisioner',
  lifecycle: 'lifecycle-manager',
  security: 'security-detection',
};

/** The part a `source` names, or null when the platform has no such part. */
export function roleOf(source: string): ActorRole | null {
  return BY_ID.get(ALIASES[source] ?? source) ?? null;
}

/** A part's formal name; an unknown source keeps its own name. */
export function labelOf(source: string): string {
  return roleOf(source)?.label ?? source;
}

/**
 * What the screen calls a part. The rows, the boxes and the captions all print this
 * one, with the formal name beside it or behind it — never instead of it, because
 * `agent-op` on its own is what nobody could read.
 */
export function nameOf(source: string): string {
  return roleOf(source)?.name ?? source;
}

/** The one phrase for a part, or an empty string when there is nothing fixed to say. */
export function roleTextOf(source: string): string {
  return roleOf(source)?.role ?? '';
}

/**
 * Everything that took part in a set of events, named as this dictionary names it.
 *
 * An event's `source` is only who published it. One tool call is published by the Agent
 * Runtime alone and passes through three other parts on the way — the record lists them
 * as hops — so a list built from `source` would tell a reader about one box while the
 * picture beside it showed four.
 */
export function partiesIn(events: Iterable<{
  source: string;
  detail?: Record<string, unknown> | undefined;
  record?: { hops?: ReadonlyArray<{ from: string; to: string }> | undefined } | undefined;
}>): string[] {
  const parties: string[] = [];
  for (const event of events) {
    parties.push(event.source);
    const target = event.detail?.['target'];
    if (typeof target === 'string') parties.push(target);
    for (const hop of event.record?.hops ?? []) parties.push(hop.from, hop.to);
  }
  return parties;
}

/** The parts a set of sources involved, in the story's order rather than the events'. */
export function rolesFor(sources: Iterable<string>): ActorRole[] {
  const wanted = new Set<string>();
  for (const source of sources) {
    const actor = roleOf(source);
    if (actor) wanted.add(actor.id);
  }
  return ACTOR_ROLES.filter((actor) => wanted.has(actor.id));
}
