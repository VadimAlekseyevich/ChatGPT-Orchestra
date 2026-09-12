(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function asText(value, max = 4000) {
    const text = String(value || "").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function normalizeIssues(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => ({
      severity: String(item.severity || "medium").toLowerCase(),
      code: asText(item.code || "review_issue", 120),
      message: asText(item.message, 1500),
      evidence: asText(item.evidence, 2000),
      file: item.file ? asText(item.file, 500) : null,
      suggestion: item.suggestion ? asText(item.suggestion, 1500) : null
    }));
  }

  function validateReviewPayload(eventType, payload, task) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "review_payload_invalid" };
    const criteria = Array.isArray(payload.criteria) ? payload.criteria : [];
    const expected = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria.map(String) : [];
    const byCriterion = new Map();
    for (const item of criteria) {
      if (!item || typeof item !== "object") continue;
      const criterion = String(item.criterion || "");
      if (!criterion || byCriterion.has(criterion)) continue;
      byCriterion.set(criterion, {
        criterion,
        status: String(item.status || "").toUpperCase(),
        evidence: asText(item.evidence, 2500),
        comment: item.comment ? asText(item.comment, 1500) : null
      });
    }
    const missingCriteria = expected.filter((criterion) => !byCriterion.has(criterion));
    if (missingCriteria.length) return { ok: false, reason: "review_criteria_incomplete", missingCriteria };

    const normalizedCriteria = expected.map((criterion) => byCriterion.get(criterion));
    const scopeCheck = payload.scopeCheck && typeof payload.scopeCheck === "object" ? {
      status: String(payload.scopeCheck.status || "").toUpperCase(),
      evidence: asText(payload.scopeCheck.evidence, 2500)
    } : { status: "", evidence: "" };
    const testsAssessment = payload.testsAssessment && typeof payload.testsAssessment === "object" ? {
      status: String(payload.testsAssessment.status || "").toUpperCase(),
      evidence: asText(payload.testsAssessment.evidence, 2500)
    } : { status: "", evidence: "" };
    const issues = normalizeIssues(payload.issues);
    const requiredChanges = Array.isArray(payload.requiredChanges)
      ? payload.requiredChanges.map((item) => asText(item, 1500)).filter(Boolean)
      : [];
    const normalized = {
      summary: asText(payload.summary, 3000),
      criteria: normalizedCriteria,
      scopeCheck,
      testsAssessment,
      issues,
      requiredChanges
    };

    if (eventType === "REVIEW_APPROVED") {
      if (normalizedCriteria.some((item) => item.status !== "PASS" || !item.evidence)) return { ok: false, reason: "approval_requires_all_criteria_pass" };
      if (scopeCheck.status !== "PASS" || !scopeCheck.evidence) return { ok: false, reason: "approval_requires_scope_pass" };
      if (!["PASS", "WAIVED"].includes(testsAssessment.status) || !testsAssessment.evidence) return { ok: false, reason: "approval_requires_tests_assessment" };
      if (issues.some((item) => ["high", "critical", "blocking"].includes(item.severity)) || requiredChanges.length) {
        return { ok: false, reason: "approval_contains_blocking_changes" };
      }
    } else if (eventType === "CHANGES_REQUIRED") {
      const hasFailure = normalizedCriteria.some((item) => item.status === "FAIL") || scopeCheck.status === "FAIL" || testsAssessment.status === "FAIL";
      if (!hasFailure && !issues.length && !requiredChanges.length) return { ok: false, reason: "changes_required_without_findings" };
      if (!requiredChanges.length) return { ok: false, reason: "changes_required_missing_actions" };
    } else {
      return { ok: false, reason: "unsupported_review_event" };
    }
    return { ok: true, review: normalized };
  }

  class ReviewEngine {
    constructor({ store, schedulerStore, projectStore, registry, eventBus, gitProvider = null, sendPrompt, onSchedulerTick = null, clock = () => Date.now(), logger = console } = {}) {
      this.store = store;
      this.schedulerStore = schedulerStore;
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.gitProvider = gitProvider;
      this.sendPrompt = sendPrompt;
      this.onSchedulerTick = onSchedulerTick;
      this.clock = clock;
      this.logger = logger;
      this.initialized = false;
      this.unsubscribers = [];
      this.tickPromise = Promise.resolve();
    }

    getPublicState() { return this.store.summary(); }
    activeReviewerAgentIds() { return this.store.activeReviewerIds(); }
    activeCount() { return this.store.active().length; }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.store.load();
      const projectId = this.schedulerStore.summary().projectId || this.projectStore.getActiveProject()?.projectId;
      if (projectId) await this.store.ensureProject(projectId);
      if (!this.unsubscribers.length) {
        this.unsubscribers.push(this.eventBus.subscribe("review", (record) => this.handleReviewEvent(record)));
        this.unsubscribers.push(this.eventBus.subscribe("blocker", (record) => this.handleReviewFailureEvent(record)));
        this.unsubscribers.push(this.eventBus.subscribe("user", (record) => this.handleReviewFailureEvent(record)));
      }
      await this.restoreActiveReviews();
      this.initialized = true;
      return this.getPublicState();
    }

    async restoreActiveReviews() {
      for (const review of this.store.active()) {
        const reviewer = this.registry.getAgent(review.reviewerAgentId);
        if (!reviewer || !Number.isInteger(reviewer.tabId) || ["OFFLINE", "ERROR"].includes(reviewer.status)) {
          await this.store.requeue(review.reviewId, "reviewer_unavailable_after_restart");
          continue;
        }
        if (review.reviewerAgentId === review.authorAgentId) {
          await this.escalate("persisted_self_review_detected", review.taskId, { reviewId: review.reviewId });
          continue;
        }
        await this.registry.setProtocolContext(review.reviewerAgentId, {
          projectId: this.store.summary().projectId,
          taskId: review.taskId,
          runId: review.reviewId
        });
      }
    }

    async enqueueForWorkerCompletion({ task, run, workerReport }) {
      const projectId = this.schedulerStore.summary().projectId;
      await this.store.ensureProject(projectId);
      const current = this.schedulerStore.getTask(task.id);
      const iteration = (Number(current?.reviewIterations) || 0) + 1;
      const enqueued = await this.store.enqueue({
        taskId: task.id,
        workerRunId: run.runId,
        authorAgentId: run.agentId,
        iteration,
        packetSeed: { workerReport: clone(workerReport || {}) }
      });
      if (!enqueued.ok) return enqueued;
      await this.schedulerStore.markReviewPending?.(task.id, enqueued.review.reviewId, workerReport || {});
      await this.schedulerStore.logDecision("review_queued", {
        taskId: task.id,
        workerRunId: run.runId,
        reviewId: enqueued.review.reviewId,
        iteration,
        authorAgentId: run.agentId
      });
      await this.tick({ reason: "worker_done" });
      return { ok: true, review: enqueued.review };
    }

    reviewerCandidates(review, task) {
      const workerBusy = new Set(this.schedulerStore.activeRuns().map((run) => run.agentId));
      const reviewBusy = new Set(this.store.activeReviewerIds());
      const requested = new Set(Array.isArray(task?.definition?.reviewerCapabilities) ? task.definition.reviewerCapabilities : []);
      return this.registry.listAgents().filter((agent) => (
        agent.role === "worker"
        && Number.isInteger(agent.tabId)
        && agent.status === "IDLE"
        && agent.agentId !== review.authorAgentId
        && !workerBusy.has(agent.agentId)
        && !reviewBusy.has(agent.agentId)
      )).sort((a, b) => {
        const capsA = new Set(Array.isArray(a.capabilities) ? a.capabilities : []);
        const capsB = new Set(Array.isArray(b.capabilities) ? b.capabilities : []);
        const scoreA = [...requested].filter((cap) => capsA.has(cap)).length;
        const scoreB = [...requested].filter((cap) => capsB.has(cap)).length;
        return scoreB - scoreA || a.agentId.localeCompare(b.agentId);
      });
    }

    architectureRules(project) {
      const discovery = project?.artifacts?.DISCOVERY || {};
      const plan = project?.artifacts?.PLAN_V2 || {};
      return {
        repositoryInstructions: discovery.repositoryInstructions || discovery.instructions || null,
        architectureRules: plan.architectureRules || discovery.architectureRules || null
      };
    }

    async buildPacket(review, task) {
      const project = this.projectStore.getActiveProject();
      const workerRun = this.schedulerStore.getRun(review.workerRunId);
      const artifact = task.lastArtifact || workerRun?.git?.artifact || null;
      let diff = null;
      if (artifact?.commit && this.gitProvider?.getReviewDiff) {
        const fetched = await this.gitProvider.getReviewDiff(project, artifact.baseSha, artifact.commit);
        if (!fetched.ok) return { ok: false, reason: fetched.reason || "review_diff_unavailable", details: fetched };
        diff = fetched.diff;
      }
      return {
        ok: true,
        packet: {
          task: clone(task.definition || task),
          acceptanceCriteria: clone(task.acceptanceCriteria || []),
          architectureRules: this.architectureRules(project),
          worker: {
            authorAgentId: review.authorAgentId,
            workerRunId: review.workerRunId,
            summary: review.packetSeed?.workerReport?.summary || "",
            testsPerformed: clone(review.packetSeed?.workerReport?.testsPerformed || []),
            knownLimitations: clone(review.packetSeed?.workerReport?.knownLimitations || [])
          },
          artifact: clone(artifact),
          diff,
          scope: clone(task.scope || {}),
          verification: clone(task.verification || []),
          provenance: {
            gitValidated: artifact ? true : !root.GitProvider?.requiresGitArtifact?.(task.definition || task),
            reviewIteration: review.iteration
          }
        }
      };
    }

    async dispatch(review, reviewer) {
      if (reviewer.agentId === review.authorAgentId) return { ok: false, reason: "self_review_forbidden" };
      const task = this.schedulerStore.getTask(review.taskId);
      const project = this.projectStore.getActiveProject();
      const packetResult = await this.buildPacket(review, task);
      if (!packetResult.ok) {
        await this.escalate(packetResult.reason, review.taskId, packetResult.details || null);
        return packetResult;
      }
      const assigned = await this.store.assign(review.reviewId, reviewer.agentId);
      if (!assigned.ok) return assigned;
      const bound = await this.registry.setProtocolContext(reviewer.agentId, {
        projectId: project.projectId,
        taskId: review.taskId,
        runId: review.reviewId
      });
      if (!bound) {
        await this.store.requeue(review.reviewId, "review_context_bind_failed");
        return { ok: false, reason: "review_context_bind_failed" };
      }
      const prompt = root.ReviewPrompts.buildReviewPrompt({ project, task: task.definition || task, review: assigned.review, packet: packetResult.packet, agentId: reviewer.agentId });
      const sent = await this.sendPrompt(reviewer.agentId, prompt);
      if (!sent?.ok) {
        await this.registry.clearProtocolContext(reviewer.agentId);
        await this.store.requeue(review.reviewId, "review_dispatch_failed");
        await this.schedulerStore.logDecision("review_dispatch_failed", { reviewId: review.reviewId, taskId: review.taskId, reviewerAgentId: reviewer.agentId, result: sent });
        return { ok: false, reason: "review_dispatch_failed" };
      }
      await this.schedulerStore.markReviewing?.(review.taskId, review.reviewId, reviewer.agentId);
      await this.schedulerStore.logDecision("review_assigned", {
        reviewId: review.reviewId,
        taskId: review.taskId,
        workerRunId: review.workerRunId,
        authorAgentId: review.authorAgentId,
        reviewerAgentId: reviewer.agentId,
        iteration: review.iteration
      });
      return { ok: true };
    }

    async tick({ reason = "review_tick" } = {}) {
      this.tickPromise = this.tickPromise.catch(() => {}).then(async () => {
        if (this.schedulerStore.summary().status !== "RUNNING") return { ok: false, reason: "scheduler_not_running" };
        const assigned = [];
        for (const review of this.store.pending()) {
          const task = this.schedulerStore.getTask(review.taskId);
          if (!task || !["DONE_BY_WORKER", "REVIEW_PENDING", "REVIEWING"].includes(task.status)) continue;
          const reviewer = this.reviewerCandidates(review, task)[0];
          if (!reviewer) continue;
          const result = await this.dispatch(review, reviewer);
          if (result.ok) assigned.push({ reviewId: review.reviewId, taskId: review.taskId, reviewerAgentId: reviewer.agentId });
        }
        return { ok: true, reason, assigned, review: this.getPublicState() };
      });
      return this.tickPromise;
    }

    matchesActiveReview(record) {
      const event = record?.event;
      if (!event || event.projectId !== this.store.summary().projectId) return null;
      const review = this.store.get(event.runId);
      if (!review || review.taskId !== event.taskId || review.reviewerAgentId !== event.agentId) return null;
      if (review.reviewerAgentId === review.authorAgentId) return null;
      if (!["ASSIGNED", "REVIEWING"].includes(review.status)) return null;
      return review;
    }

    async handleReviewEvent(record) {
      const review = this.matchesActiveReview(record);
      if (!review || !["REVIEW_APPROVED", "CHANGES_REQUIRED"].includes(record.event.event)) return;
      const task = this.schedulerStore.getTask(review.taskId);
      const validation = validateReviewPayload(record.event.event, record.event.payload || {}, task);
      if (!validation.ok) {
        await this.registry.clearProtocolContext(review.reviewerAgentId);
        await this.schedulerStore.logDecision("review_payload_invalid", { reviewId: review.reviewId, taskId: review.taskId, reason: validation.reason, details: validation });
        await this.escalate(validation.reason, review.taskId, validation);
        return;
      }
      await this.store.complete(review.reviewId, record.event.event, validation.review);
      await this.registry.clearProtocolContext(review.reviewerAgentId);

      if (record.event.event === "REVIEW_APPROVED") {
        const approved = await this.schedulerStore.markReviewApproved?.(review.taskId, {
          reviewId: review.reviewId,
          reviewerAgentId: review.reviewerAgentId,
          workerRunId: review.workerRunId,
          iteration: review.iteration,
          result: validation.review
        });
        await this.schedulerStore.logDecision("review_approved", { reviewId: review.reviewId, taskId: review.taskId, reviewerAgentId: review.reviewerAgentId, iteration: review.iteration });
        if (!approved) return this.escalate("review_approval_persist_failed", review.taskId);
      } else {
        const changed = await this.schedulerStore.markChangesRequired?.(review.taskId, {
          reviewId: review.reviewId,
          reviewerAgentId: review.reviewerAgentId,
          workerRunId: review.workerRunId,
          iteration: review.iteration,
          result: validation.review,
          maxReviewIterations: this.store.summary().settings.maxReviewIterations
        });
        await this.schedulerStore.logDecision("changes_required", {
          reviewId: review.reviewId,
          taskId: review.taskId,
          reviewerAgentId: review.reviewerAgentId,
          iteration: review.iteration,
          nextStatus: changed?.status || null,
          requiredChanges: validation.review.requiredChanges
        });
        if (changed?.status === "NEEDS_USER") {
          await this.escalate("max_review_iterations_exhausted", review.taskId, { reviewId: review.reviewId, iteration: review.iteration });
          return;
        }
      }
      await this.onSchedulerTick?.({ reason: record.event.event === "REVIEW_APPROVED" ? "review_approved" : "changes_required" });
    }

    async handleReviewFailureEvent(record) {
      const review = this.matchesActiveReview(record);
      if (!review || !["BLOCKED", "ERROR", "NEEDS_USER"].includes(record.event.event)) return;
      await this.registry.clearProtocolContext(review.reviewerAgentId);
      await this.schedulerStore.logDecision("reviewer_failed", { reviewId: review.reviewId, taskId: review.taskId, event: record.event.event, payload: record.event.payload || {} });
      await this.escalate(`reviewer_${record.event.event.toLowerCase()}`, review.taskId, record.event.payload || {});
    }

    async handleAgentUnavailable(agentId, reason = "reviewer_unavailable") {
      const review = this.store.active().find((item) => item.reviewerAgentId === agentId);
      if (!review) return { ok: true, ignored: true };
      await this.registry.clearProtocolContext(agentId);
      await this.store.requeue(review.reviewId, reason);
      await this.schedulerStore.markReviewPending?.(review.taskId, review.reviewId, null);
      await this.schedulerStore.logDecision("reviewer_unavailable", { reviewId: review.reviewId, taskId: review.taskId, reviewerAgentId: agentId, reason });
      await this.tick({ reason: "reviewer_unavailable" });
      return { ok: true, handled: true };
    }

    async handleAgentStateChanged(agent) {
      if (agent?.role === "worker" && agent.status === "IDLE") await this.tick({ reason: "worker_idle_for_review" });
    }

    async escalate(reason, taskId, details = null) {
      await this.schedulerStore.setStatus("NEEDS_USER");
      const projectId = this.schedulerStore.summary().projectId;
      await this.projectStore.setExecutionStatus?.(projectId, "NEEDS_USER", { phase: 7, reason, taskId: taskId || null, details });
      await this.schedulerStore.logDecision("needs_user", { phase: 7, reason, taskId: taskId || null, details });
    }
  }

  root.ReviewEngine = ReviewEngine;
  root.validateReviewPayload = validateReviewPayload;
  if (typeof module !== "undefined" && module.exports) module.exports = { ReviewEngine, validateReviewPayload, normalizeIssues };
})();