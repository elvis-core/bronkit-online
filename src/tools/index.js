// Tool registry. Read tools + read-composites are wired up now; write tools
// land in the next milestone (aggregated here the same way).

import { readTools } from "./reads.js";
import { compositeTools } from "./composites.js";
import { writeTools } from "./writes.js";
import { configTools } from "./config.js";
import { intentTools } from "./intents.js";
import { strategyTools } from "./strategies.js";
import { swapTools } from "./swap.js";
import { assetsTools } from "./assets.js";

export const tools = [...readTools, ...compositeTools, ...writeTools, ...configTools, ...intentTools, ...strategyTools, ...swapTools, ...assetsTools];
export const toolsByName = new Map(tools.map((t) => [t.name, t]));
