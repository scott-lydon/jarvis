// Tool registry. Single place that wires every concrete tool into the
// dispatcher. Keeping this in one file makes it trivial for the system
// prompt to enumerate the LIVE surface (US-05) and for `npm run
// healthz` to print which tools are on.
//
// Adding a tool: write the file under src/tools/<name>.ts exporting a
// `ToolDefinition`, then add a single line below.

import type { ToolDispatcher } from './dispatcher.js';
import { weatherTool } from './weather.js';
import { memoryWriteTool, preferenceUpsertTool, preferenceDeleteTool } from './memory.js';
import {
  githubListPrsTool,
  githubListIssuesTool,
  githubGetPrCommentsTool,
  githubListRecentMergesTool,
  githubOpenPrForIssueTool,
} from './github.js';

export function registerAllTools(dispatcher: ToolDispatcher): void {
  dispatcher.register(weatherTool);
  dispatcher.register(memoryWriteTool);
  dispatcher.register(preferenceUpsertTool);
  dispatcher.register(preferenceDeleteTool);
  dispatcher.register(githubListPrsTool);
  dispatcher.register(githubListIssuesTool);
  dispatcher.register(githubGetPrCommentsTool);
  dispatcher.register(githubListRecentMergesTool);
  dispatcher.register(githubOpenPrForIssueTool);
}
