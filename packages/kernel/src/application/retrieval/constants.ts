// Candidate ceiling before JS re-rank. Episodic decay only lowers scores, so the
// final top-N is contained in the top bm25 candidates. A fixed 100-cap
// scan; raise or paginate if a project ever holds enough matching nodes to notice.
export const CANDIDATE_CAP = 100;
export const DECAY_DAYS = 14;
export const USE_SATURATION = 20; // fetches at which the importance prior reaches its ceiling

// Hybrid retrieval constants.
export const RRF_K = 60; // RRF damping; 1/(60+rank)
export const FUSE_CAP = 40; // top-N from each branch fed into fusion
export const PPR_DEPTH = 2; // hops of subgraph pulled around the query-matched nodes
export const PPR_ITERS = 20; // power-iteration ceiling; converges well before this at our scale
export const PPR_EPSILON = 1e-6; // L1 delta at which iteration stops early
export const BEST_CHUNK_CHARS = 120;

// Edge-type conductance for PPR diffusion: how much rank flows along an edge of this type,
// multiplied by the edge's own stored weight. `supersedes` is absent, so a superseded node
// is never reachable this way. Code structure (`calls`/`defines`/`imports`) is absent too —
// 255k structural edges would swamp the diffusion, and `code_lookup` serves them directly;
// `documents` is what keeps the prose↔code join traversable.
export const EDGE_WEIGHTS: Record<string, number> = {
  derived_from: 0.5,
  documents: 0.7,
  references: 0.7,
  relates_to: 0.5,
  similar_to: 0.3,
};

export const TRAVERSABLE = Object.keys(EDGE_WEIGHTS);
