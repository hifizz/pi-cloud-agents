// Real call to Exa via the web_search tool. Usage: node scratch/search-demo.mjs "query"
import "../src/config.mjs"; // loads .env into process.env
import { createWebSearchTool } from "../src/ext/search.mjs";

const query = process.argv[2] ?? "Node.js current LTS version";
const tool = createWebSearchTool();
try {
  const out = await tool.execute({ query, numResults: 3 }, {}, {});
  console.log(`query: ${query}`);
  out.details.slice(0, 3).forEach((r, i) => console.log(`${i + 1}. ${r.title}\n   ${r.url}`));
} catch (e) {
  console.error(`search failed: ${e.message}`);
  process.exit(1);
}
