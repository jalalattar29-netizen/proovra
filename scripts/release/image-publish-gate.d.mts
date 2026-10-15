export interface RequiredWorkflow {
  readonly file: string;
  readonly name: string;
}

export interface WorkflowRunFact {
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt?: number;
  created_at?: string;
}

export interface PublicationDecision {
  publish: boolean;
  tagLatest: boolean;
  reason: string;
}

export const REQUIRED_WORKFLOWS: ReadonlyArray<RequiredWorkflow>;

export function decidePublication(input: {
  headSha: string;
  mainSha: string;
  runs: Record<string, WorkflowRunFact[]>;
  required?: ReadonlyArray<RequiredWorkflow>;
}): PublicationDecision;
