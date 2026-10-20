import { writeFileSync } from "node:fs";
import type { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

type Candidate = ReturnType<
  ReturnType<typeof createPriorCiCandidateFactory>["preExistingCandidate"]
>;
type Job = NonNullable<ReturnType<Candidate["state"]>["priorCi"]["jobs"]>[number];

export function cancelledFailure(
  f: Candidate,
  name: string,
  steps: NonNullable<Job["steps"]>,
  workflowJob: string,
  number: number,
  caseName: string,
) {
  const state = f.state();
  const check = state.priorCi.deadline.check;
  Object.assign(check, { name, head_sha: f.head, completed_at: "2026-09-20T00:02:04Z" });
  Object.assign(state.priorCi.jobs![0]!, {
    name,
    conclusion: "cancelled",
    steps,
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
  });
  const evidence = {
    ...f.evidence,
    failures: f.evidence.failures.map((entry) => ({
      ...entry,
      cases: [caseName],
      failedStep: { number, workflowJob },
    })),
  };
  f.save(state);
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}
