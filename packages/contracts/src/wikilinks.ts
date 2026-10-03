// A `[[link]]` in a live note that resolves to no live node, as the dashboard lists it.
export interface WikilinkDangler {
  node_id: string;
  node_title: string;
  project: string | null;
  link: string;
  reason: "unknown" | "ambiguous";
  // An episodic note is write-once: its link can be ignored but not rewritten.
  editable: boolean;
  suggestions: { id: string; title: string }[];
  // The model's pick, when the sweep judged this link and left it for the owner.
  verdict: WikilinkVerdict | null;
}

export interface WikilinkVerdict {
  // null: no note is what the link meant, so it should be unlinked.
  target: { id: string; title: string } | null;
  confidence: "high" | "low";
  reason: string;
  judged_at: string;
}

export const WIKILINK_FIX_ACTIONS = ["rewrite", "unlink", "ignore"] as const;

export type WikilinkFixAction = (typeof WIKILINK_FIX_ACTIONS)[number];

export interface WikilinkFix {
  node_id: string;
  link: string;
  action: WikilinkFixAction;
  // The node a `rewrite` points the link at.
  target_id?: string;
}

export interface WikilinkFixResult {
  node_id: string;
  action: WikilinkFixAction;
  // Links rewritten in the note's body; 0 for `ignore`.
  rewritten: number;
}
