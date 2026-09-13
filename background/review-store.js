(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.reviews.v1";
  const SCHEMA_VERSION = 1;
  const DEFAULTS = Object.freeze({ maxReviewIterations: 3 });

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: null,
      settings: { ...DEFAULTS },
      reviews: {},
      order: [],
      updatedAt: 0
    };
  }

  function normalizeSettings(value = {}) {
    return {
      maxReviewIterations: Math.max(1, Math.min(10, Number(value.maxReviewIterations) || DEFAULTS.maxReviewIterations))
    };
  }

  class ReviewStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local, clock = () => Date.now(), idFactory = null } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.idFactory = idFactory || (() => `review-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`);
      this.state = defaultState();
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) return this.snapshot();
      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION) {
        this.state = {
          ...defaultState(),
          ...candidate,
          settings: normalizeSettings(candidate.settings),
          reviews: { ...(candidate.reviews || {}) },
          order: Array.isArray(candidate.order) ? [...candidate.order] : []
        };
      }
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }
    get(reviewId) { const review = this.state.reviews[reviewId]; return review ? clone(review) : null; }
    list() { return this.state.order.map((id) => this.get(id)).filter(Boolean); }
    pending() { return this.list().filter((review) => review.status === "PENDING"); }
    active() { return this.list().filter((review) => ["ASSIGNED", "REVIEWING"].includes(review.status)); }
    activeReviewerIds() { return [...new Set(this.active().map((review) => review.reviewerAgentId).filter(Boolean))]; }

    summary() {
      const counts = {};
      for (const review of this.list()) counts[review.status] = (counts[review.status] || 0) + 1;
      return {
        projectId: this.state.projectId,
        settings: clone(this.state.settings),
        counts,
        pending: this.pending().length,
        active: this.active().length,
        total: this.state.order.length,
        updatedAt: this.state.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.storageArea?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    async ensureProject(projectId, settings = {}) {
      const id = String(projectId || "").trim();
      if (!id) return { ok: false, reason: "project_id_missing" };
      if (this.state.projectId && this.state.projectId !== id) this.state = defaultState();
      this.state.projectId = id;
      this.state.settings = normalizeSettings({ ...this.state.settings, ...settings });
      await this.persist();
      return { ok: true, review: this.summary() };
    }

    makeReview({ taskId, workerRunId, authorAgentId, iteration, packetSeed = null, retryOf = null }) {
      const reviewId = this.idFactory();
      const now = this.clock();
      return {
        reviewId,
        taskId: String(taskId || ""),
        workerRunId: String(workerRunId || ""),
        authorAgentId: String(authorAgentId || ""),
        reviewerAgentId: null,
        iteration: Math.max(1, Number(iteration) || 1),
        retryOf: retryOf || null,
        status: "PENDING",
        packetSeed: packetSeed ? clone(packetSeed) : null,
        assignedAt: null,
        startedAt: null,
        completedAt: null,
        result: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      };
    }

    async enqueue({ taskId, workerRunId, authorAgentId, iteration, packetSeed = null } = {}) {
      const existing = this.list().find((review) => review.workerRunId === workerRunId && ["PENDING", "ASSIGNED", "REVIEWING"].includes(review.status));
      if (existing) return { ok: true, duplicate: true, review: existing };
      const review = this.makeReview({ taskId, workerRunId, authorAgentId, iteration, packetSeed });
      this.state.reviews[review.reviewId] = review;
      this.state.order.push(review.reviewId);
      await this.persist();
      return { ok: true, review: this.get(review.reviewId) };
    }

    async assign(reviewId, reviewerAgentId) {
      const review = this.state.reviews[reviewId];
      if (!review || review.status !== "PENDING") return { ok: false, reason: "review_not_pending" };
      if (!reviewerAgentId || reviewerAgentId === review.authorAgentId) return { ok: false, reason: "self_review_forbidden" };
      const now = this.clock();
      review.reviewerAgentId = reviewerAgentId;
      review.status = "ASSIGNED";
      review.assignedAt = now;
      review.updatedAt = now;
      review.lastError = null;
      await this.persist();
      return { ok: true, review: this.get(reviewId) };
    }

    async markReviewing(reviewId) {
      const review = this.state.reviews[reviewId];
      if (!review || !["ASSIGNED", "REVIEWING"].includes(review.status)) return null;
      const now = this.clock();
      review.status = "REVIEWING";
      if (!review.startedAt) review.startedAt = now;
      review.updatedAt = now;
      await this.persist();
      return this.get(reviewId);
    }

    async requeue(reviewId, reason) {
      const review = this.state.reviews[reviewId];
      if (!review) return null;
      const now = this.clock();
      review.status = "ABANDONED";
      review.lastError = String(reason || "reviewer_unavailable");
      review.completedAt = now;
      review.updatedAt = now;

      const replacement = this.makeReview({
        taskId: review.taskId,
        workerRunId: review.workerRunId,
        authorAgentId: review.authorAgentId,
        iteration: review.iteration,
        packetSeed: review.packetSeed,
        retryOf: review.reviewId
      });
      this.state.reviews[replacement.reviewId] = replacement;
      this.state.order.push(replacement.reviewId);
      await this.persist();
      return this.get(replacement.reviewId);
    }

    async complete(reviewId, eventType, payload) {
      const review = this.state.reviews[reviewId];
      if (!review || !["ASSIGNED", "REVIEWING"].includes(review.status)) return null;
      const now = this.clock();
      review.status = String(eventType || "").toUpperCase() === "REVIEW_APPROVED" ? "APPROVED" : "CHANGES_REQUIRED";
      review.result = clone(payload || {});
      review.completedAt = now;
      review.updatedAt = now;
      await this.persist();
      return this.get(reviewId);
    }

    async fail(reviewId, reason, details = null) {
      const review = this.state.reviews[reviewId];
      if (!review || !["PENDING", "ASSIGNED", "REVIEWING"].includes(review.status)) return null;
      const now = this.clock();
      review.status = "FAILED";
      review.lastError = String(reason || "review_failed");
      review.result = details && typeof details === "object" ? clone(details) : null;
      review.completedAt = now;
      review.updatedAt = now;
      await this.persist();
      return this.get(reviewId);
    }
  }

  root.ReviewStore = ReviewStore;
  root.REVIEW_STORE_STORAGE_KEY = STORAGE_KEY;
  root.REVIEW_DEFAULTS = DEFAULTS;
  if (typeof module !== "undefined" && module.exports) module.exports = { ReviewStore, STORAGE_KEY, SCHEMA_VERSION, DEFAULTS, normalizeSettings };
})();