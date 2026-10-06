(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  const DEFAULT_TURN_ROOTS = Object.freeze([
    '[data-testid^="conversation-turn-"]',
    'article[data-turn]',
    'section[data-turn]',
    'article[data-message-author-role]'
  ]);
  const DEFAULT_ASSISTANT_ROLE_MARKERS = Object.freeze([
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-message-author="assistant"]',
    '[data-turn="assistant"]'
  ]);
  const DEFAULT_ASSISTANT_BODIES = Object.freeze([
    '.markdown',
    '.prose',
    '[class*="markdown"]',
    '[data-message-content]'
  ]);

  function normalizeText(text) {
    return String(text || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .trimEnd();
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function byteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    try { return encodeURIComponent(text).replace(/%[0-9A-F]{2}|./gi, "x").length; } catch (_) { return text.length; }
  }

  function uniqueSelectors(values, fallback = []) {
    const normalized = [];
    const seen = new Set();
    for (const value of [...(Array.isArray(values) ? values : []), ...fallback]) {
      const selector = String(value || "").trim();
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      normalized.push(selector);
    }
    return normalized;
  }

  function safeQueryAll(target, selector) {
    if (!target || typeof target.querySelectorAll !== "function" || !selector) return [];
    try { return Array.from(target.querySelectorAll(selector) || []); } catch (_) { return []; }
  }

  function safeMatches(element, selector) {
    if (!element || typeof element.matches !== "function" || !selector) return false;
    try { return Boolean(element.matches(selector)); } catch (_) { return false; }
  }

  function readAttribute(element, name) {
    if (!element || typeof element.getAttribute !== "function") return "";
    try { return String(element.getAttribute(name) || ""); } catch (_) { return ""; }
  }

  function compareDom(left, right) {
    if (left === right) return 0;
    if (typeof left?.compareDocumentPosition !== "function") return null;
    try {
      const position = left.compareDocumentPosition(right);
      if (position & 1) return null;
      if (position & 4) return -1;
      if (position & 2) return 1;
    } catch (_) {}
    return null;
  }

  class AssistantTurnTracker {
    constructor({
      documentRef = globalThis.document,
      locationRef = globalThis.location,
      selectors = root.SELECTORS || {},
      maxHistory = 64
    } = {}) {
      this.documentRef = documentRef;
      this.locationRef = locationRef;
      this.maxHistory = Math.max(8, Math.min(256, Number(maxHistory) || 64));
      this.elementTurnIds = new WeakMap();
      this.setSelectors(selectors);
      this.currentConversationKey = null;
      this.previousTurns = [];
      this.latestSnapshot = null;
      this.identityRegistry = new Map();
      this.identityOrder = [];
      this.nextOrdinal = 1;
      this.observedTurnCount = 0;
      this.hasObserved = false;
      this.hasEverSeenTurn = false;
    }

    setSelectors(selectors = {}) {
      this.selectors = selectors || {};
      this.turnRootSelectors = uniqueSelectors(this.selectors.turnRoots, DEFAULT_TURN_ROOTS);
      this.roleSelectors = uniqueSelectors(this.selectors.assistantRoleMarkers, DEFAULT_ASSISTANT_ROLE_MARKERS);
      this.bodySelectors = uniqueSelectors(this.selectors.assistantBodies, DEFAULT_ASSISTANT_BODIES);
      this.assistantDiscoverySelectors = new Set(uniqueSelectors([
        ...(Array.isArray(this.selectors.assistantMessages) ? this.selectors.assistantMessages : []),
        ...this.roleSelectors
      ]));
      this.discoverySelectors = uniqueSelectors([
        ...this.assistantDiscoverySelectors,
        ...this.turnRootSelectors
      ]).sort();
      this.turnRootQuery = [...this.turnRootSelectors].sort().join(",");
    }

    conversationKey() {
      return String(this.locationRef?.pathname || "") || "/";
    }

    resetConversation(conversationKey = this.conversationKey()) {
      this.currentConversationKey = String(conversationKey || "/");
      this.previousTurns = [];
      this.latestSnapshot = null;
      this.identityRegistry.clear();
      this.identityOrder = [];
      this.nextOrdinal = 1;
      this.observedTurnCount = 0;
      this.hasEverSeenTurn = false;
    }

    resolveCanonicalElement(element) {
      if (!element) return null;
      if (this.turnRootQuery && typeof element.closest === "function") {
        try {
          const closest = element.closest(this.turnRootQuery);
          if (closest) return closest;
        } catch (_) {}
      }
      return element;
    }

    roleMarkersWithin(element) {
      const markers = [];
      const seen = new Set();
      for (const selector of this.roleSelectors) {
        if (safeMatches(element, selector) && !seen.has(element)) {
          seen.add(element);
          markers.push(element);
        }
        for (const candidate of safeQueryAll(element, selector)) {
          if (seen.has(candidate)) continue;
          if (this.resolveCanonicalElement(candidate) !== element) continue;
          seen.add(candidate);
          markers.push(candidate);
        }
      }
      return markers;
    }

    isAssistantTurn(element, assistantHint = false) {
      if (!element) return false;
      const explicitRole = [
        readAttribute(element, "data-message-author-role"),
        readAttribute(element, "data-role"),
        readAttribute(element, "data-message-author"),
        readAttribute(element, "data-turn")
      ].map((value) => value.toLowerCase()).filter(Boolean);
      if (explicitRole.includes("assistant")) return true;
      if (explicitRole.some((value) => value && value !== "assistant")) return false;
      if (this.roleMarkersWithin(element).length > 0) return true;
      return Boolean(assistantHint);
    }

    stableIdentityKey(element) {
      const testId = readAttribute(element, "data-testid").trim();
      if (testId && testId.length <= 160 && /^conversation-turn-[A-Za-z0-9._:-]+$/.test(testId)) {
        return `testid:${testId}`;
      }
      return "";
    }

    extractText(element) {
      if (!element) return "";
      const candidates = [];
      const seen = new Set();
      for (const selector of this.bodySelectors) {
        for (const candidate of safeQueryAll(element, selector)) {
          if (!candidate || seen.has(candidate)) continue;
          seen.add(candidate);
          candidates.push(candidate);
        }
      }
      const source = candidates.length
        ? candidates.sort((left, right) => {
          const leftText = normalizeText(left.innerText || left.textContent || "");
          const rightText = normalizeText(right.innerText || right.textContent || "");
          if (leftText.length !== rightText.length) return rightText.length - leftText.length;
          return compareDom(left, right) ?? 0;
        })[0]
        : element;
      return normalizeText(source?.innerText || source?.textContent || "");
    }

    discoverCandidates() {
      const candidates = new Map();
      for (const selector of this.discoverySelectors) {
        const assistantHint = this.assistantDiscoverySelectors.has(selector);
        for (const element of safeQueryAll(this.documentRef, selector)) {
          candidates.set(element, Boolean(candidates.get(element)) || assistantHint);
        }
      }
      return [...candidates].map(([element, assistantHint]) => ({ element, assistantHint }));
    }

    dedupeCanonicalTurns(entries) {
      const canonicalHints = new Map();
      for (const entry of entries) {
        const rootElement = this.resolveCanonicalElement(entry?.element);
        if (!rootElement) continue;
        canonicalHints.set(rootElement, Boolean(canonicalHints.get(rootElement)) || Boolean(entry?.assistantHint));
      }
      const canonical = [];
      for (const [rootElement, assistantHint] of canonicalHints) {
        if (!this.isAssistantTurn(rootElement, assistantHint)) continue;
        canonical.push(rootElement);
      }

      const byStableIdentity = new Map();
      const withoutStableIdentity = [];
      for (const element of canonical) {
        const stableKey = this.stableIdentityKey(element);
        if (!stableKey) {
          withoutStableIdentity.push(element);
          continue;
        }
        const existing = byStableIdentity.get(stableKey);
        if (!existing) {
          byStableIdentity.set(stableKey, element);
          continue;
        }
        const existingText = this.extractText(existing);
        const currentText = this.extractText(element);
        if (currentText.length > existingText.length) byStableIdentity.set(stableKey, element);
        else if (currentText.length === existingText.length && compareDom(element, existing) === -1) byStableIdentity.set(stableKey, element);
      }
      return [...byStableIdentity.values(), ...withoutStableIdentity];
    }

    orderCanonicalTurns(elements) {
      if (elements.length < 2) return { ok: true, elements: [...elements] };
      const rootOrder = new Map();
      if (this.turnRootQuery) {
        safeQueryAll(this.documentRef, this.turnRootQuery).forEach((element, index) => {
          const canonical = this.resolveCanonicalElement(element);
          if (canonical && !rootOrder.has(canonical)) rootOrder.set(canonical, index);
        });
      }
      let ambiguous = false;
      const ordered = [...elements].sort((left, right) => {
        const direct = compareDom(left, right);
        if (direct !== null) return direct;
        const leftIndex = rootOrder.get(left);
        const rightIndex = rootOrder.get(right);
        if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex) && leftIndex !== rightIndex) return leftIndex - rightIndex;
        ambiguous = true;
        return 0;
      });
      if (ambiguous) return { ok: false, reason: "assistant_turn_order_ambiguous", elements: [] };
      return { ok: true, elements: ordered };
    }

    discoverCanonicalTurns() {
      return this.orderCanonicalTurns(this.dedupeCanonicalTurns(this.discoverCandidates()));
    }

    newTurnId(conversationKey) {
      const ordinal = this.nextOrdinal++;
      const id = `turn-${hashString(conversationKey)}-${ordinal}`;
      this.observedTurnCount += 1;
      return id;
    }

    rememberStableIdentity(stableKey, turnId) {
      if (!stableKey) return;
      if (!this.identityRegistry.has(stableKey)) this.identityOrder.push(stableKey);
      this.identityRegistry.set(stableKey, turnId);
      while (this.identityOrder.length > this.maxHistory) {
        const oldest = this.identityOrder.shift();
        if (oldest) this.identityRegistry.delete(oldest);
      }
    }

    descriptorFor(element) {
      const stableKey = this.stableIdentityKey(element);
      const text = this.extractText(element);
      return {
        element,
        stableKey,
        text,
        textFingerprint: text ? hashString(text) : "",
        textBytes: byteLength(text),
        turnId: "",
        identitySource: stableKey ? "dom-attribute" : "session-local",
        matchedPreviousIndex: -1
      };
    }

    matchDescriptor(descriptor, previous, previousIndex, source) {
      if (!previous?.turnId || descriptor.turnId) return false;
      descriptor.turnId = previous.turnId;
      descriptor.identitySource = descriptor.stableKey ? "dom-attribute" : source;
      descriptor.matchedPreviousIndex = previousIndex;
      return true;
    }

    reconcile(descriptors, conversationKey, { initial = false } = {}) {
      const previous = this.previousTurns;
      const usedPrevious = new Set();

      for (const descriptor of descriptors) {
        if (descriptor.stableKey) {
          const registered = this.identityRegistry.get(descriptor.stableKey);
          const previousIndex = previous.findIndex((item) => item.stableKey === descriptor.stableKey || (registered && item.turnId === registered));
          if (previousIndex >= 0) {
            this.matchDescriptor(descriptor, previous[previousIndex], previousIndex, "dom-attribute");
            usedPrevious.add(previousIndex);
          } else if (registered) {
            descriptor.turnId = registered;
            descriptor.identitySource = "dom-attribute";
          } else {
            descriptor.turnId = this.newTurnId(conversationKey);
            descriptor.identitySource = "dom-attribute";
            this.rememberStableIdentity(descriptor.stableKey, descriptor.turnId);
          }
        }
      }

      descriptors.forEach((descriptor) => {
        if (descriptor.turnId) return;
        const nodeTurnId = this.elementTurnIds.get(descriptor.element);
        if (!nodeTurnId) return;
        const previousIndex = previous.findIndex((item, index) => !usedPrevious.has(index) && item.turnId === nodeTurnId);
        if (previousIndex < 0) return;
        this.matchDescriptor(descriptor, previous[previousIndex], previousIndex, "node-continuity");
        usedPrevious.add(previousIndex);
      });

      const previousFingerprintCounts = new Map();
      const currentFingerprintCounts = new Map();
      previous.forEach((item, index) => {
        if (usedPrevious.has(index) || !item.textFingerprint) return;
        const list = previousFingerprintCounts.get(item.textFingerprint) || [];
        list.push(index);
        previousFingerprintCounts.set(item.textFingerprint, list);
      });
      descriptors.forEach((descriptor, index) => {
        if (descriptor.turnId || !descriptor.textFingerprint) return;
        const list = currentFingerprintCounts.get(descriptor.textFingerprint) || [];
        list.push(index);
        currentFingerprintCounts.set(descriptor.textFingerprint, list);
      });
      for (const [fingerprint, currentIndexes] of currentFingerprintCounts) {
        const previousIndexes = previousFingerprintCounts.get(fingerprint) || [];
        if (currentIndexes.length !== 1 || previousIndexes.length !== 1) continue;
        const currentIndex = currentIndexes[0];
        const previousIndex = previousIndexes[0];
        if (usedPrevious.has(previousIndex)) continue;
        this.matchDescriptor(descriptors[currentIndex], previous[previousIndex], previousIndex, "structural");
        usedPrevious.add(previousIndex);
      }

      const anchors = descriptors
        .map((item, currentIndex) => ({ currentIndex, previousIndex: item.matchedPreviousIndex }))
        .filter((item) => item.previousIndex >= 0)
        .sort((left, right) => left.currentIndex - right.currentIndex);
      for (let index = 1; index < anchors.length; index += 1) {
        if (anchors[index].previousIndex <= anchors[index - 1].previousIndex) {
          return { ok: false, reason: "assistant_turn_identity_ambiguous" };
        }
      }

      const boundaries = [
        { currentIndex: -1, previousIndex: -1 },
        ...anchors,
        { currentIndex: descriptors.length, previousIndex: previous.length }
      ];
      for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
        const left = boundaries[boundaryIndex];
        const right = boundaries[boundaryIndex + 1];
        const currentGap = [];
        const previousGap = [];
        for (let index = left.currentIndex + 1; index < right.currentIndex; index += 1) {
          if (!descriptors[index].turnId) currentGap.push(index);
        }
        for (let index = left.previousIndex + 1; index < right.previousIndex; index += 1) {
          if (!usedPrevious.has(index)) previousGap.push(index);
        }
        if (!currentGap.length && !previousGap.length) continue;

        const hasAnchor = left.currentIndex >= 0 || right.currentIndex < descriptors.length;
        if (currentGap.length === previousGap.length && currentGap.length > 0 && hasAnchor) {
          for (let offset = 0; offset < currentGap.length; offset += 1) {
            const currentIndex = currentGap[offset];
            const previousIndex = previousGap[offset];
            this.matchDescriptor(descriptors[currentIndex], previous[previousIndex], previousIndex, "structural");
            usedPrevious.add(previousIndex);
          }
          continue;
        }

        const tailExtension = right.currentIndex === descriptors.length && right.previousIndex === previous.length;
        if (tailExtension && previousGap.length === 0 && currentGap.length > 0 && (left.currentIndex >= 0 || previous.length === 0)) {
          for (const currentIndex of currentGap) {
            const descriptor = descriptors[currentIndex];
            descriptor.turnId = this.newTurnId(conversationKey);
            descriptor.identitySource = descriptor.stableKey ? "dom-attribute" : "session-local";
            if (descriptor.stableKey) this.rememberStableIdentity(descriptor.stableKey, descriptor.turnId);
          }
          continue;
        }

        if (initial && previous.length === 0 && previousGap.length === 0) {
          for (const currentIndex of currentGap) {
            const descriptor = descriptors[currentIndex];
            descriptor.turnId = this.newTurnId(conversationKey);
            descriptor.identitySource = descriptor.stableKey ? "dom-attribute" : "session-local";
            if (descriptor.stableKey) this.rememberStableIdentity(descriptor.stableKey, descriptor.turnId);
          }
          continue;
        }

        if (currentGap.length === 0) continue;
        return { ok: false, reason: "assistant_turn_identity_ambiguous" };
      }

      for (const descriptor of descriptors) {
        if (!descriptor.turnId) return { ok: false, reason: "assistant_turn_identity_ambiguous" };
      }
      return { ok: true };
    }

    turnDto(descriptor, conversationKey, index) {
      return {
        turnId: descriptor.turnId,
        role: "assistant",
        conversationKey,
        ordinal: Number(String(descriptor.turnId || "").split("-").at(-1)) || (index + 1),
        identitySource: descriptor.identitySource,
        text: descriptor.text,
        textFingerprint: descriptor.textFingerprint,
        textBytes: descriptor.textBytes
      };
    }

    observe() {
      const conversationKey = this.conversationKey();
      const conversationChanged = this.currentConversationKey !== null && this.currentConversationKey !== conversationKey;
      if (this.currentConversationKey === null || conversationChanged) this.resetConversation(conversationKey);

      const discovery = this.discoverCanonicalTurns();
      if (!discovery.ok) {
        return {
          ok: false,
          reason: discovery.reason,
          conversationKey,
          conversationChanged,
          assistantTurnCountObserved: this.observedTurnCount,
          mountedTurnCount: 0
        };
      }

      const descriptors = discovery.elements.map((element) => this.descriptorFor(element));
      const initial = !this.hasObserved || conversationChanged;
      const reconciliation = this.reconcile(descriptors, conversationKey, { initial });
      if (!reconciliation.ok) {
        return {
          ok: false,
          reason: reconciliation.reason,
          conversationKey,
          conversationChanged,
          assistantTurnCountObserved: this.observedTurnCount,
          mountedTurnCount: descriptors.length
        };
      }

      const previousLatest = this.latestSnapshot;
      for (const descriptor of descriptors) this.elementTurnIds.set(descriptor.element, descriptor.turnId);
      const turns = descriptors.map((descriptor, index) => this.turnDto(descriptor, conversationKey, index));
      const latest = turns.at(-1) || null;
      const latestTurnId = latest?.turnId || "";
      const latestText = latest?.text || "";
      const latestTextFingerprint = latest?.textFingerprint || "";
      const hydrationCandidate = Boolean(
        this.hasObserved
        && !this.hasEverSeenTurn
        && this.previousTurns.length === 0
        && turns.length > 0
      );
      const turnChanged = Boolean(
        !hydrationCandidate
        && previousLatest
        && latestTurnId
        && latestTurnId !== previousLatest.latestTurnId
      );
      const textChanged = Boolean(
        !hydrationCandidate
        && previousLatest
        && latestTurnId
        && latestTurnId === previousLatest.latestTurnId
        && latestTextFingerprint !== previousLatest.latestTextFingerprint
      );
      const responseFingerprint = latestText
        ? hashString(`${conversationKey}:${latestTurnId}:${latestText}`)
        : "";

      const snapshot = {
        ok: true,
        conversationKey,
        conversationChanged,
        latestTurnId,
        latestText,
        latestTextFingerprint,
        latestIdentitySource: latest?.identitySource || "",
        turnChanged,
        textChanged,
        hydrationCandidate,
        assistantTurnCountObserved: this.observedTurnCount,
        mountedTurnCount: turns.length,
        responseFingerprint,
        turns
      };

      this.previousTurns = descriptors.slice(-this.maxHistory).map((descriptor) => ({
        turnId: descriptor.turnId,
        stableKey: descriptor.stableKey,
        textFingerprint: descriptor.textFingerprint,
        identitySource: descriptor.identitySource
      }));
      this.latestSnapshot = {
        latestTurnId,
        latestTextFingerprint
      };
      this.hasObserved = true;
      if (turns.length) this.hasEverSeenTurn = true;
      return snapshot;
    }

    getTurns() {
      return this.observe().turns || [];
    }

    getLatestAssistantTurn() {
      return this.observe().turns?.at(-1) || null;
    }

    getSnapshot() {
      return this.observe();
    }

    getCanonicalTurnElements() {
      const result = this.discoverCanonicalTurns();
      return result.ok ? result.elements : [];
    }
  }

  root.AssistantTurnTracker = AssistantTurnTracker;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AssistantTurnTracker;
  }
})();
