/** PHASE 12 — POINT 8: types for the executable deployment graph. */
export interface WorkflowNode {
  workflow: string;
  triggers: string[];
  branchFilters: Record<string, string[]>;
  automatic: boolean;
  manualOnly: boolean;
  unknownTriggers: string[];
  effects: string[];
  productionDeliveryPath: boolean;
  environment: string | null;
}
export declare function buildDeploymentGraph(): {
  nodes: WorkflowNode[];
  metrics: {
    workflows: number;
    UnknownDeploymentTriggers: number;
    productionDeliveryPaths: string[];
    StagingPathCanTriggerProduction: boolean;
  };
};
