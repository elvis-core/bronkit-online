// Tool registry. Read tools + read-composites are wired up now; write tools
// land in the next milestone (aggregated here the same way).

import { readTools } from "./reads.js";
import { compositeTools } from "./composites.js";
import { writeTools } from "./writes.js";
import { configTools } from "./config.js";

export const tools = [...readTools, ...compositeTools, ...writeTools, ...configTools];
export const toolsByName = new Map(tools.map((t) => [t.name, t]));
