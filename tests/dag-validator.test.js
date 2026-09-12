const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTaskGraph } = require("../background/dag-validator.js");

function validGraph() {
  return {
    objectiveCoveredBy: ["T2"],
    tasks: [
      {
        id: "T1",
        title: "Foundation",
        objective: "Prepare the base implementation.",
        kind: "code",
        dependencies: [],
        scope: { allow: ["src/**"] },
        acceptanceCriteria: ["foundation is implemented"],
        verification: ["npm test"],
        priority: 80,
        risk: "low",
        estimatedComplexity: "M"
      },
      {
        id: "T2",
        title: "Integration",
        objective: "Integrate and verify the project goal.",
        kind: "code",
        dependencies: ["T1"],
        scope: { allow: ["tests/**"] },
        acceptanceCriteria: ["integration is covered"],
        verification: ["npm test"],
        priority: 70,
        risk: "low",
        estimatedComplexity: "S"
      }
    ]
  };
}

test("accepts a valid acyclic task graph and produces topological order", () => {
  const result = validateTaskGraph(validGraph());
  assert.equal(result.ok, true);
  assert.deepEqual(result.topologicalOrder, ["T1", "T2"]);
  assert.equal(result.stats.tasks, 2);
});

test("rejects cycles and missing quality gates", () => {
  const graph = validGraph();
  graph.tasks[0].dependencies = ["T2"];
  graph.tasks[0].acceptanceCriteria = [];
  graph.tasks[1].verification = [];
  const result = validateTaskGraph(graph);
  assert.equal(result.ok, false);
  const codes = result.errors.map((item) => item.code);
  assert.ok(codes.includes("dependency_cycle"));
  assert.ok(codes.includes("acceptance_criteria_missing"));
  assert.ok(codes.includes("verification_missing"));
});

test("requires rationale for large tasks and a migration safety plan", () => {
  const graph = validGraph();
  graph.tasks[0].estimatedComplexity = "L";
  graph.tasks[0].risk = "database schema migration";
  const result = validateTaskGraph(graph);
  const codes = result.errors.map((item) => item.code);
  assert.ok(codes.includes("large_task_without_rationale"));
  assert.ok(codes.includes("migration_safety_missing"));
});

test("rejects unknown dependencies and missing objective coverage", () => {
  const graph = validGraph();
  graph.tasks[1].dependencies = ["NOPE"];
  graph.objectiveCoveredBy = [];
  const result = validateTaskGraph(graph);
  const codes = result.errors.map((item) => item.code);
  assert.ok(codes.includes("dependency_missing"));
  assert.ok(codes.includes("objective_coverage_missing"));
});
