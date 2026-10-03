import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import type {
  CandidateDecisionBody,
  CandidateView,
  NodePreview,
  ReviewItemView,
  ReviewNode,
} from "@cerebrium/contracts/dashboard";
import type { ConsolidationCandidate, ConsolidationProposal } from "@cerebrium/contracts/types";
import type { WikilinkDangler, WikilinkFix } from "@cerebrium/contracts/wikilinks";
import {
  decideCandidate,
  decideReview,
  errorMessage,
  fetchCandidates,
  fetchDanglers,
  fetchReviews,
  fixWikilink,
  retryCandidate,
  type CandidateKind,
} from "../api";
import { absoluteTime, clockTime, relativeTime, truncate } from "../format";
import type { Tone } from "../health";
import { Badge, Card, Empty, ErrorText, Mono, Notice, RelTime, useNow } from "./common";

export const CANDIDATES_KEY = ["review", "candidates"] as const;
export const REVIEWS_KEY = ["review", "runner"] as const;
export const DANGLERS_KEY = ["review", "danglers"] as const;

const KINDS: CandidateKind[] = ["distill", "merge", "supersede", "link", "prune", "documents"];

const KIND_TONE: Record<CandidateKind, Tone> = {
  distill: "info",
  merge: "info",
  link: "neutral",
  documents: "neutral",
  prune: "warn",
  supersede: "warn",
};

type ProposalFilter = "all" | "has" | "waiting";

type Draft = Required<CandidateDecisionBody>["override"];

function kindOf(candidate: ConsolidationCandidate): CandidateKind {
  return candidate.kind as string as CandidateKind;
}

function generates(kind: CandidateKind): boolean {
  return kind === "distill" || kind === "merge";
}

function matchesProposal(view: CandidateView, filter: ProposalFilter): boolean {
  const { candidate } = view;
  if (filter === "has") return candidate.proposal !== null;
  if (filter === "waiting") return generates(kindOf(candidate)) && candidate.proposal === null;
  return true;
}

function describe(view: CandidateView): string {
  return truncate(view.members[0]?.title ?? view.candidate.id, 60);
}

function nodeName(node: ReviewNode | undefined): string {
  return node ? node.title || node.id : "?";
}

function previewName(node: NodePreview | undefined): string {
  return node ? node.title || node.id : "?";
}

function describeItem(item: ReviewItemView): string {
  return item.artifact === "edge"
    ? `${nodeName(item.src)} —${item.edge_type ?? "?"}→ ${nodeName(item.dst)}`
    : nodeName(item.node);
}

function itemKey(item: ReviewItemView): string {
  return `${item.artifact}:${item.ref}`;
}

interface Outcome {
  key: number;
  tone: Tone;
  text: string;
}

function useOutcomes(): [Outcome[], (tone: Tone, text: string) => void] {
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: Tone, text: string) => {
    seq.current += 1;
    const key = seq.current;
    setOutcomes((prev) => [{ key, tone, text }, ...prev].slice(0, 3));
  }, []);
  return [outcomes, push];
}

function useIdSet() {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const add = useCallback((id: string) => setIds((prev) => new Set(prev).add(id)), []);
  const remove = useCallback(
    (id: string) =>
      setIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
    [],
  );
  return { ids, add, remove };
}

function useErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = useCallback(
    (id: string, message: string | null) =>
      setErrors((prev) => {
        if (message === null && !(id in prev)) return prev;
        const next = { ...prev };
        if (message === null) delete next[id];
        else next[id] = message;
        return next;
      }),
    [],
  );
  return [errors, set] as const;
}

export function Review({ onCount }: { onCount: (count: number) => void }) {
  const candidates = useCandidates();
  const runner = useRunnerReviews();
  const total = candidates.loaded.length + runner.pendingTotal;

  useEffect(() => onCount(total), [onCount, total]);

  return (
    <div className="stack">
      <CandidatesSection state={candidates} />
      <RunnerSection state={runner} />
      <DanglersSection />
    </div>
  );
}

interface DecisionVars {
  view: CandidateView;
  label: string;
  body: CandidateDecisionBody;
}

function useCandidates() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<CandidateKind | "">("");
  const [proposal, setProposal] = useState<ProposalFilter>("all");
  const hidden = useIdSet();
  const retrying = useIdSet();
  const [errors, setError] = useErrors();
  const [outcomes, pushOutcome] = useOutcomes();

  const query = useInfiniteQuery({
    queryKey: [...CANDIDATES_KEY, kind],
    queryFn: ({ pageParam, signal }) =>
      fetchCandidates({ kind: kind || null, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const all = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.candidates), [query.data]);
  const loaded = useMemo(
    () => all.filter((v) => !hidden.ids.has(v.candidate.id)),
    [all, hidden.ids],
  );
  const shown = useMemo(() => all.filter((v) => matchesProposal(v, proposal)), [all, proposal]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY });

  const decide = useMutation({
    mutationFn: ({ view, body }: DecisionVars) => decideCandidate(view.candidate.id, body),
    onMutate: ({ view }) => {
      setError(view.candidate.id, null);
      hidden.add(view.candidate.id);
    },
    onSuccess: (result, { view, label }) => {
      pushOutcome("ok", `${label} (${result.status}) · ${describe(view)}`);
    },
    onError: (error, { view }) => {
      hidden.remove(view.candidate.id);
      setError(view.candidate.id, errorMessage(error));
    },
    onSettled: invalidate,
  });

  const retry = useMutation({
    mutationFn: (view: CandidateView) => retryCandidate(view.candidate.id),
    onMutate: (view) => {
      setError(view.candidate.id, null);
      retrying.add(view.candidate.id);
    },
    onSuccess: (_result, view) => {
      pushOutcome("info", `Proposal cleared · ${describe(view)} — rewritten on a later sweep`);
    },
    onError: (error, view) => setError(view.candidate.id, errorMessage(error)),
    onSettled: (_result, _error, view) => {
      retrying.remove(view.candidate.id);
      return invalidate();
    },
  });

  return {
    query,
    kind,
    setKind,
    proposal,
    setProposal,
    loaded,
    shown,
    hidden: hidden.ids,
    retrying: retrying.ids,
    errors,
    outcomes,
    decide: decide.mutate,
    retry: retry.mutate,
  };
}

type CandidatesState = ReturnType<typeof useCandidates>;

function Outcomes({ outcomes }: { outcomes: Outcome[] }) {
  return (
    <ul className="outcomes" aria-live="polite">
      {outcomes.map((o) => (
        <li key={o.key} className={`toast toast-${o.tone}`}>
          {o.text}
        </li>
      ))}
    </ul>
  );
}

function CandidatesSection({ state }: { state: CandidatesState }) {
  const { query, loaded, shown, hidden } = state;
  const visibleCount = shown.filter((v) => !hidden.has(v.candidate.id)).length;
  const error = query.isError ? errorMessage(query.error) : null;
  const perKind = useMemo(() => {
    const counts = new Map<CandidateKind, number>();
    for (const v of loaded) {
      const kind = kindOf(v.candidate);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return KINDS.flatMap((k) => {
      const n = counts.get(k);
      return n ? [[k, n] as const] : [];
    });
  }, [loaded]);

  return (
    <section className="review-section" aria-labelledby="candidates-title">
      <header className="section-head">
        <h2 id="candidates-title">Consolidation candidates</h2>
        {perKind.length > 0 && (
          <ul className="chips" aria-label="Loaded per kind">
            {perKind.map(([kind, n]) => (
              <li key={kind}>
                {kind} <span className="num">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div className="toolbar">
        <label>
          Kind
          <select
            value={state.kind}
            onChange={(e) => state.setKind(e.target.value as CandidateKind | "")}
          >
            <option value="">All</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Proposal
          <select
            value={state.proposal}
            onChange={(e) => state.setProposal(e.target.value as ProposalFilter)}
          >
            <option value="all">All</option>
            <option value="has">Has proposal</option>
            <option value="waiting">Waiting for model</option>
          </select>
        </label>
        <span className="toolbar-count muted">
          {visibleCount.toLocaleString()} shown of {loaded.length.toLocaleString()} loaded
          {query.hasNextPage ? " · more available" : ""}
        </span>
      </div>

      <Outcomes outcomes={state.outcomes} />

      {error && (
        <Notice tone={query.data ? "warn" : "err"}>Cannot load candidates: {error}.</Notice>
      )}

      {!query.data ? (
        query.isPending && <p className="loading">Loading candidates…</p>
      ) : visibleCount === 0 ? (
        <Empty>
          {loaded.length === 0 ? "No pending candidates." : "No candidates match the filters."}
        </Empty>
      ) : null}

      {shown.map((view) => (
        <CandidateCard
          key={view.candidate.id}
          view={view}
          hidden={hidden.has(view.candidate.id)}
          retrying={state.retrying.has(view.candidate.id)}
          error={state.errors[view.candidate.id] ?? null}
          onDecide={(label, body) => state.decide({ view, label, body })}
          onRetry={() => state.retry(view)}
        />
      ))}

      {query.data && (query.hasNextPage || query.isFetchNextPageError) && (
        <div className="pager">
          {query.isFetchNextPageError && (
            <span className="error-text">{errorMessage(query.error)}</span>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

interface CardProps {
  view: CandidateView;
  hidden: boolean;
  retrying: boolean;
  error: string | null;
  onDecide: (label: string, body: CandidateDecisionBody) => void;
  onRetry: () => void;
}

function CandidateCard({ view, hidden, retrying, error, onDecide, onRetry }: CardProps) {
  const { candidate, members } = view;
  const kind = kindOf(candidate);
  const proposal = candidate.proposal;
  const retired = members.some((node) => node.invalidated);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState<{ draft: Draft; edited: boolean } | null>(null);

  const rejectLabel = REJECT_LABEL[kind] ?? "Reject";
  const reject = () => onDecide(rejectLabel, { decision: "reject" });

  const survivor = members.find((node) => node.id === candidate.canonical_id);
  const duplicate = members.find((node) => node.id !== candidate.canonical_id);

  const submitDraft = (draft: Draft) => {
    if (kind === "merge") {
      setEditing(false);
      setMerging({ draft, edited: true });
    } else {
      onDecide("Applied", { decision: "apply", override: draft });
    }
  };

  const confirmMerge = () => {
    if (!merging) return;
    setMerging(null);
    onDecide("Merged", {
      decision: "apply",
      collapse: true,
      ...(merging.edited ? { override: merging.draft } : {}),
    });
  };

  return (
    <article
      className="card candidate"
      hidden={hidden}
      aria-label={`${kind} candidate: ${describe(view)}`}
    >
      <header className="candidate-head">
        <Badge tone={KIND_TONE[kind]}>{kind}</Badge>
        <span className="muted">
          score <span className="num">{candidate.score.toFixed(2)}</span>
        </span>
        {candidate.project && <span className="muted">{candidate.project}</span>}
        <span className="muted">
          detected <RelTime iso={candidate.detected_at} />
        </span>
        {candidate.attempts > 0 && (
          <Badge tone={candidate.last_error ? "err" : "neutral"}>
            {candidate.attempts} attempt{candidate.attempts === 1 ? "" : "s"}
          </Badge>
        )}
        <Mono text={candidate.id} max={12} />
      </header>
      <div className="card-body">
        {candidate.last_error && (
          <div className="sub">
            Last error: <ErrorText text={candidate.last_error} max={200} />
          </div>
        )}

        {proposal ? (
          kind === "supersede" ? (
            <Verdict proposal={proposal} />
          ) : (
            <ProposalBlock proposal={proposal} />
          )
        ) : (
          generates(kind) && (
            <p className="waiting muted">
              Waiting for the model — it works through the queue one candidate at a time.
            </p>
          )
        )}

        <div className="members">
          {members.map((node, index) => (
            <Member key={node.id} node={node} role={memberRole(kind, candidate, node, index)} />
          ))}
        </div>

        {editing && (
          <ProposalEditor
            initial={proposal}
            submitLabel={kind === "merge" ? "Merge into one" : "Apply"}
            onSubmit={submitDraft}
            onCancel={() => setEditing(false)}
          />
        )}

        {merging && (
          <MergeConfirm
            survivor={survivor}
            duplicate={duplicate}
            body={merging.draft.body}
            missing={merging.edited ? undefined : proposal?.missing}
            onConfirm={confirmMerge}
            onCancel={() => setMerging(null)}
          />
        )}

        {error && <Notice tone="err">{error}</Notice>}

        {retired && (
          <Notice tone="warn">
            A member was retired after this was detected, so there is nothing left to consolidate.
            Reject it; the next sweep dismisses it anyway.
          </Notice>
        )}

        <div className="actions">
          {!retired && kind === "distill" && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!proposal}
                title={proposal ? undefined : "No proposal yet"}
                onClick={() => onDecide("Applied", { decision: "apply" })}
              >
                Apply
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
              >
                Edit &amp; apply
              </button>
            </>
          )}
          {!retired && kind === "merge" && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onDecide("Marked duplicate", { decision: "apply", collapse: false })}
              >
                Keep both, mark duplicate
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!proposal || merging !== null}
                title={proposal ? undefined : "No proposal yet"}
                onClick={() => {
                  if (proposal) setMerging({ draft: proposal, edited: false });
                }}
              >
                Merge into one
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
              >
                Edit &amp; merge
              </button>
            </>
          )}
          {!retired && (kind === "link" || kind === "documents") && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onDecide("Applied", { decision: "apply" })}
            >
              Apply
            </button>
          )}
          {!retired && kind === "supersede" && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                if (window.confirm(SUPERSEDE_CONFIRM)) {
                  onDecide("Superseded", { decision: "apply" });
                }
              }}
            >
              Retire older
            </button>
          )}
          {!retired && kind === "prune" && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                if (window.confirm("Retire this node? It is invalidated (soft-deleted).")) {
                  onDecide("Retired", { decision: "apply" });
                }
              }}
            >
              Retire node
            </button>
          )}
          <button type="button" className={retired ? "btn btn-primary" : "btn"} onClick={reject}>
            {retired ? "Reject" : rejectLabel}
          </button>
          {!retired && generates(kind) && (
            <button type="button" className="btn" disabled={retrying} onClick={onRetry}>
              {retrying ? "Regenerating…" : "Regenerate"}
            </button>
          )}
        </div>

        {!retired && ACTION_HINTS[kind] && (
          <dl className="action-hints sub muted">
            {ACTION_HINTS[kind].map(([action, effect]) => (
              <div key={action}>
                <dt>{action}</dt>
                <dd>{effect}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </article>
  );
}

const REJECT_LABEL: Partial<Record<CandidateKind, string>> = {
  merge: "Not duplicates",
  supersede: "Keep both",
};

const ACTION_HINTS: Partial<Record<CandidateKind, [string, string][]>> = {
  merge: [
    ["Keep both, mark duplicate", "nothing is rewritten; search shows the two as one result."],
    ["Merge into one", "the kept note is rewritten to the merged text, the duplicate is retired."],
    ["Not duplicates", "dismisses the suggestion; nothing changes."],
  ],
  supersede: [
    ["Retire older", "the older note is retired and its links move to the newer one."],
    ["Keep both", "dismisses the suggestion; the two stay related."],
  ],
};

const LOSSY_RATIO = 0.7;

interface MergeConfirmProps {
  survivor: NodePreview | undefined;
  duplicate: NodePreview | undefined;
  body: string;
  missing: string[] | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

function MergeConfirm({
  survivor,
  duplicate,
  body,
  missing,
  onConfirm,
  onCancel,
}: MergeConfirmProps) {
  const kept = survivor?.content?.length ?? 0;
  const longest = Math.max(kept, duplicate?.content?.length ?? 0);
  const lossy = longest > 0 && body.length < longest * LOSSY_RATIO;
  const shorter = longest > 0 ? Math.round((1 - body.length / longest) * 100) : 0;

  return (
    <div className="merge-confirm" role="group" aria-label="Confirm merge">
      <p>
        <strong>{truncate(previewName(survivor), 80)}</strong> is rewritten to the merged text (
        <span className="num">{kept.toLocaleString()}</span> →{" "}
        <span className="num">{body.length.toLocaleString()}</span> chars).{" "}
        <strong>{truncate(previewName(duplicate), 80)}</strong> is retired and its links move to the
        kept note.
      </p>
      {lossy && (
        <Notice tone="warn">
          The merged text is {shorter}% shorter than the longer note — whatever it leaves out is
          lost. Edit it first, or keep both and mark duplicate.
        </Notice>
      )}
      <Missing anchors={missing} />
      <div className="actions">
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          Merge
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Missing({ anchors }: { anchors: string[] | undefined }) {
  if (!anchors?.length) return null;
  return <Notice tone="warn">Not carried over from the sources: {anchors.join(", ")}</Notice>;
}

const SUPERSEDE_CONFIRM =
  "Retire the older note? It is invalidated and its links move to the newer one.";

function Verdict({ proposal }: { proposal: ConsolidationProposal }) {
  if (!proposal.recommendation) return null;
  return (
    <div className="proposal-verdict">
      <Badge tone={proposal.recommendation === "apply" ? "ok" : "warn"}>
        model: {proposal.recommendation}
      </Badge>
      {proposal.reason && <span>{proposal.reason}</span>}
    </div>
  );
}

function ProposalBlock({ proposal }: { proposal: ConsolidationProposal }) {
  return (
    <div className="proposal">
      <Verdict proposal={proposal} />
      <h3 className="proposal-title">{proposal.title}</h3>
      {proposal.summary && <p className="proposal-summary">{proposal.summary}</p>}
      <Clamp text={proposal.body} lines={12} />
      <Missing anchors={proposal.missing} />
    </div>
  );
}

function memberRole(
  kind: CandidateKind,
  candidate: ConsolidationCandidate,
  node: NodePreview,
  index: number,
): [Tone, string] | null {
  if (kind === "merge" && candidate.canonical_id) {
    return node.id === candidate.canonical_id ? ["ok", "keeps"] : ["warn", "duplicate"];
  }
  if (kind === "supersede" && candidate.canonical_id) {
    return node.id === candidate.canonical_id ? ["ok", "newer"] : ["warn", "older"];
  }
  if (kind === "link" && candidate.canonical_id) {
    return node.id === candidate.canonical_id ? ["info", "target"] : ["neutral", "source"];
  }
  if (kind === "documents") return index === 1 ? ["info", "code symbol"] : ["neutral", "note"];
  return null;
}

function Member({ node, role }: { node: NodePreview; role: [Tone, string] | null }) {
  const gone = !node.found || node.invalidated;
  return (
    <div className={gone ? "member member-gone" : "member"}>
      <div className="member-head">
        {role && <Badge tone={role[0]}>{role[1]}</Badge>}
        {!node.found && <Badge tone="err">not found</Badge>}
        {node.invalidated && <Badge tone="err">invalidated</Badge>}
        <strong className="member-title">{node.title ?? "(untitled)"}</strong>
      </div>
      <div className="member-meta sub muted">
        {node.type && <span>{node.type}</span>}
        {node.project && <span>{node.project}</span>}
        <Mono text={node.id} max={18} />
      </div>
      {node.content ? (
        <Clamp text={node.content} lines={6} />
      ) : (
        <span className="sub muted">No content.</span>
      )}
    </div>
  );
}

function Clamp({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 90;
  const clamped = long && !open;
  return (
    <div className="clamp">
      <pre
        className={clamped ? "clamp-text clamp-on" : "clamp-text"}
        style={clamped ? { WebkitLineClamp: lines } : undefined}
      >
        {text}
      </pre>
      {long && (
        <button
          type="button"
          className="link-btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

interface EditorProps {
  initial: ConsolidationProposal | null;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}

function ProposalEditor({ initial, submitLabel, onSubmit, onCancel }: EditorProps) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>({
    title: initial?.title ?? "",
    summary: initial?.summary ?? "",
    body: initial?.body ?? "",
  });
  const valid = draft.title.trim() !== "" && draft.body.trim() !== "";
  const field = (key: keyof Draft) => ({
    id: `${id}-${key}`,
    value: draft[key],
    onChange: (e: { target: { value: string } }) =>
      setDraft((prev) => ({ ...prev, [key]: e.target.value })),
  });

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (valid) onSubmit(draft);
  };

  return (
    <form className="editor" onSubmit={submit}>
      <label htmlFor={`${id}-title`}>Title</label>
      <input type="text" required {...field("title")} />
      <label htmlFor={`${id}-summary`}>Summary</label>
      <textarea rows={2} {...field("summary")} />
      <label htmlFor={`${id}-body`}>Body</label>
      <textarea rows={10} required {...field("body")} />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!valid}>
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface ReviewVars {
  item: ReviewItemView;
  decision: "kept" | "undone";
}

function useRunnerReviews() {
  const queryClient = useQueryClient();
  const hidden = useIdSet();
  const [errors, setError] = useErrors();
  const [outcomes, pushOutcome] = useOutcomes();

  const query = useQuery({
    queryKey: REVIEWS_KEY,
    queryFn: ({ signal }) => fetchReviews(signal),
    refetchInterval: 60_000,
  });

  const decide = useMutation({
    mutationFn: ({ item, decision }: ReviewVars) =>
      decideReview({ artifact: item.artifact, ref: item.ref, decision }),
    onMutate: ({ item }) => {
      setError(itemKey(item), null);
      hidden.add(itemKey(item));
    },
    onSuccess: (result, { item, decision }) => {
      const what = truncate(describeItem(item), 80);
      if (decision === "kept") pushOutcome("ok", `Kept · ${what}`);
      else if (result.undone) pushOutcome("ok", `Undone · ${what}`);
      else pushOutcome("warn", `Recorded as undone, but nothing was removed · ${what}`);
    },
    onError: (error, { item }) => {
      hidden.remove(itemKey(item));
      setError(itemKey(item), errorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: REVIEWS_KEY }),
  });

  const items = query.data?.items ?? [];
  const hiddenPresent = items.filter((i) => hidden.ids.has(itemKey(i))).length;
  const pending = query.data?.pending;
  const pendingTotal = pending ? Math.max(0, pending.edges + pending.nodes - hiddenPresent) : 0;

  return {
    query,
    items,
    pendingTotal,
    hidden: hidden.ids,
    errors,
    outcomes,
    decide: decide.mutate,
  };
}

type RunnerState = ReturnType<typeof useRunnerReviews>;

function RunnerSection({ state }: { state: RunnerState }) {
  const { query, items, hidden } = state;
  const pending = query.data?.pending;
  const visible = items.filter((i) => !hidden.has(itemKey(i)));
  const error = query.isError ? errorMessage(query.error) : null;

  return (
    <Card
      title="Runner writes under review"
      tone={state.pendingTotal > 0 ? "warn" : undefined}
      aside={
        pending && (
          <span className="sub muted">
            <span className="num">{pending.edges}</span> edges ·{" "}
            <span className="num">{pending.nodes}</span> nodes pending
          </span>
        )
      }
    >
      <Outcomes outcomes={state.outcomes} />
      {error && (
        <Notice tone={query.data ? "warn" : "err"}>Cannot load runner writes: {error}.</Notice>
      )}
      {!query.data ? (
        query.isPending && <p className="loading">Loading runner writes…</p>
      ) : visible.length === 0 ? (
        <Empty>Nothing to review — every runner write has been kept or undone.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Principal</th>
                <th>What</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <RunnerRow
                  key={itemKey(item)}
                  item={item}
                  hidden={hidden.has(itemKey(item))}
                  error={state.errors[itemKey(item)] ?? null}
                  onDecide={(decision) => state.decide({ item, decision })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RunnerRow({
  item,
  hidden,
  error,
  onDecide,
}: {
  item: ReviewItemView;
  hidden: boolean;
  error: string | null;
  onDecide: (decision: "kept" | "undone") => void;
}) {
  const now = useNow();
  return (
    <tr hidden={hidden} className={error ? "row-err" : undefined}>
      <td className="num nowrap" title={`${absoluteTime(item.at)} · ${relativeTime(item.at, now)}`}>
        {clockTime(item.at, now)}
      </td>
      <td>{item.principal ?? <span className="muted">—</span>}</td>
      <td className="what">
        <ReviewWhat item={item} />
      </td>
      <td>
        <div className="actions">
          <button type="button" className="btn" onClick={() => onDecide("kept")}>
            Keep
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm(`Undo this ${item.artifact}? ${describeItem(item)}`)) {
                onDecide("undone");
              }
            }}
          >
            Undo
          </button>
        </div>
        {error && <ErrorText text={error} max={160} />}
      </td>
    </tr>
  );
}

function NodeName({ node }: { node: ReviewNode | undefined }) {
  if (!node) return <span className="muted">?</span>;
  return <span title={`${node.type} · ${node.id}`}>{node.title || node.id}</span>;
}

function ReviewWhat({ item }: { item: ReviewItemView }) {
  if (item.artifact === "edge") {
    if (!item.src && !item.dst) return <Mono text={item.ref} max={60} />;
    return (
      <>
        <NodeName node={item.src} />{" "}
        <code className="mono edge-type">—{item.edge_type ?? "?"}→</code>{" "}
        <NodeName node={item.dst} />
      </>
    );
  }
  if (!item.node) return <Mono text={item.ref} max={60} />;
  return (
    <>
      <NodeName node={item.node} /> <Badge tone="neutral">{item.node.type}</Badge>
    </>
  );
}

function danglerKey(dangler: WikilinkDangler): string {
  return `${dangler.node_id}|${dangler.link}`;
}

const FIX_LABEL: Record<WikilinkFix["action"], string> = {
  rewrite: "Rewrote",
  unlink: "Unlinked",
  ignore: "Ignored",
};

// The fix that carries out the model's pick; an episodic note can only ignore its link.
function verdictFix(dangler: WikilinkDangler): WikilinkFix | null {
  const verdict = dangler.verdict;

  if (!verdict) return null;

  const base = { node_id: dangler.node_id, link: dangler.link };

  if (!dangler.editable) return { ...base, action: "ignore" };

  return verdict.target
    ? { ...base, action: "rewrite", target_id: verdict.target.id }
    : { ...base, action: "unlink" };
}

function DanglersSection() {
  const queryClient = useQueryClient();
  const hidden = useIdSet();
  const [errors, setError] = useErrors();
  const [outcomes, pushOutcome] = useOutcomes();

  const query = useQuery({
    queryKey: DANGLERS_KEY,
    queryFn: ({ signal }) => fetchDanglers(signal),
    refetchInterval: 300_000,
  });

  const fix = useMutation({
    mutationFn: ({ body }: { dangler: WikilinkDangler; body: WikilinkFix }) => fixWikilink(body),
    onMutate: ({ dangler }) => {
      setError(danglerKey(dangler), null);
      hidden.add(danglerKey(dangler));
    },
    onSuccess: (_result, { dangler, body }) =>
      pushOutcome("ok", `${FIX_LABEL[body.action]} [[${truncate(dangler.link, 60)}]]`),
    onError: (error, { dangler }) => {
      hidden.remove(danglerKey(dangler));
      setError(danglerKey(dangler), errorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: DANGLERS_KEY }),
  });

  const acceptAll = useMutation({
    mutationFn: async (picks: { dangler: WikilinkDangler; body: WikilinkFix }[]) => {
      let accepted = 0;

      for (const { dangler, body } of picks) {
        setError(danglerKey(dangler), null);
        hidden.add(danglerKey(dangler));

        try {
          await fixWikilink(body);
          accepted++;
        } catch (error) {
          hidden.remove(danglerKey(dangler));
          setError(danglerKey(dangler), errorMessage(error));
        }
      }

      return accepted;
    },
    onSuccess: (accepted) => pushOutcome("ok", `Accepted ${String(accepted)} model picks`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: DANGLERS_KEY }),
  });

  const danglers = query.data ?? [];
  const visible = danglers.filter((d) => !hidden.ids.has(danglerKey(d)));
  const picks = visible.flatMap((dangler) => {
    const body = verdictFix(dangler);

    return body ? [{ dangler, body }] : [];
  });
  const error = query.isError ? errorMessage(query.error) : null;
  const send = (dangler: WikilinkDangler, action: WikilinkFix["action"], target_id?: string) =>
    fix.mutate({
      dangler,
      body: { node_id: dangler.node_id, link: dangler.link, action, target_id },
    });

  return (
    <Card
      title="Dangling wikilinks"
      tone={visible.length > 0 ? "warn" : undefined}
      aside={
        query.data && (
          <span className="sub muted">
            <span className="num">{visible.length}</span> links point at no note
            {picks.length > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={acceptAll.isPending}
                  onClick={() => acceptAll.mutate(picks)}
                >
                  Accept all {picks.length} model picks
                </button>
              </>
            )}
          </span>
        )
      }
    >
      <Outcomes outcomes={outcomes} />
      {error && (
        <Notice tone={query.data ? "warn" : "err"}>Cannot load dangling links: {error}.</Notice>
      )}
      {!query.data ? (
        query.isPending && <p className="loading">Loading dangling links…</p>
      ) : visible.length === 0 ? (
        <Empty>Every wikilink resolves to a note.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Note</th>
                <th>Link</th>
                <th>Fix</th>
              </tr>
            </thead>
            <tbody>
              {danglers.map((dangler) => (
                <DanglerRow
                  key={danglerKey(dangler)}
                  dangler={dangler}
                  hidden={hidden.ids.has(danglerKey(dangler))}
                  error={errors[danglerKey(dangler)] ?? null}
                  onFix={(action, target) => send(dangler, action, target)}
                  onAccept={() => {
                    const body = verdictFix(dangler);

                    if (body) fix.mutate({ dangler, body });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DanglerRow({
  dangler,
  hidden,
  error,
  onFix,
  onAccept,
}: {
  dangler: WikilinkDangler;
  hidden: boolean;
  error: string | null;
  onFix: (action: WikilinkFix["action"], target?: string) => void;
  onAccept: () => void;
}) {
  const verdict = dangler.verdict;

  return (
    <tr hidden={hidden} className={error ? "row-err" : undefined}>
      <td className="what">
        <span title={dangler.node_id}>{dangler.node_title}</span>{" "}
        {dangler.project && <Badge tone="neutral">{dangler.project}</Badge>}
      </td>
      <td className="what">
        <code className="mono">[[{truncate(dangler.link, 60)}]]</code>{" "}
        <Badge tone={dangler.reason === "ambiguous" ? "warn" : "neutral"}>
          {dangler.reason === "ambiguous" ? "ambiguous" : "no match"}
        </Badge>
      </td>
      <td>
        {verdict && (
          <div className="actions" title={verdict.reason}>
            <button type="button" className="btn btn-primary" onClick={onAccept}>
              Accept: {verdict.target ? `→ ${truncate(verdict.target.title, 40)}` : "unlink"}
            </button>
            <Badge tone={verdict.confidence === "high" ? "ok" : "warn"}>
              model, {verdict.confidence}
            </Badge>
            <span className="sub muted">{truncate(verdict.reason, 120)}</span>
          </div>
        )}
        <div className="actions">
          {dangler.editable &&
            dangler.suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className="btn"
                title={`Rewrite to [[${s.id}]]`}
                onClick={() => onFix("rewrite", s.id)}
              >
                → {truncate(s.title, 40)}
              </button>
            ))}
          {dangler.editable && (
            <button type="button" className="btn" onClick={() => onFix("unlink")}>
              Unlink
            </button>
          )}
          <button type="button" className="btn" onClick={() => onFix("ignore")}>
            Ignore
          </button>
        </div>
        {!dangler.editable && <span className="sub muted">episodic note: write-once</span>}
        {error && <ErrorText text={error} max={160} />}
      </td>
    </tr>
  );
}
