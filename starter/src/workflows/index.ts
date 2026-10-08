// Register workflows here. `npm start -- --workflow <name>` selects one.
import { exampleWorkflow } from './example-workflow.js';
import { failureDemoWorkflow } from './failure-demo.js';
import type { Workflow } from './types.js';

export const workflows: Record<string, Workflow> = {
  [exampleWorkflow.name]: exampleWorkflow,
  [failureDemoWorkflow.name]: failureDemoWorkflow,
};
