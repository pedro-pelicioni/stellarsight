/**
 * Generates the Mintlify pages under docs-site/ from the canonical markdown this repo
 * already maintains — docs/*.md, CONTRACT.md, apps/agent/README.md.
 *
 * Why derived, not authored: the SCF submission links the canonical files by path
 * (docs/ARCHITECTURE.md, docs/THREAT-MODEL.md, ...), so they cannot move, and a
 * hand-maintained copy under docs-site/ would drift the same way the integrity ledger
 * once did. This script is the same fix: every synced page is a projection of the file
 * the submission points at. Edit the canonical file, re-run `npm run docs:sync`, commit
 * both.
 *
 * Hand-authored pages (docs-site/index.mdx, docs-site/quickstart.mdx) are NOT touched.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "docs-site");
const GITHUB = "https://github.com/pedro-pelicioni/stellarsight/blob/main";

// source (repo-relative) -> { out (docs-site-relative, no extension), title, description }
const PAGES = {
  "docs/ARCHITECTURE.md": {
    out: "architecture",
    title: "Architecture",
    description: "The full system design: components, data flow, trust boundaries and the seven diagrams.",
  },
  "CONTRACT.md": {
    out: "api/contract",
    title: "API contract",
    description: "Every HTTP surface, wire shape and field name — the contract the conformance harness enforces.",
  },
  "docs/QUICKSTART-SELLER.md": {
    out: "guides/seller",
    title: "Seller quickstart",
    description: "Clone to a paid, discoverable endpoint in 59 measured seconds. No faucet, no captcha, no API key.",
  },
  "apps/agent/README.md": {
    out: "guides/agent",
    title: "Agent & MCP",
    description: "Discover and pay for services from an agent: the MCP server's four tools and the CLI.",
  },
  "docs/DEPLOY.md": {
    out: "guides/operator",
    title: "Operator guide",
    description:
      "Run your own facilitator and Bazaar: deploy topology, environment, catalog modes, rate limits, and curl verification.",
  },
  "docs/THREAT-MODEL.md": {
    out: "security/threat-model",
    title: "Threat model",
    description: "Thirteen threats, each mapped to the control that answers it and the test that proves it.",
  },
  "docs/MONITORING.md": {
    out: "security/monitoring",
    title: "Monitoring plan",
    description: "Signal, threshold and response per surface — what exists today and what is funded work.",
  },
  "docs/EVIDENCE.md": {
    out: "evidence/verify-it-yourself",
    title: "Verify it yourself",
    description:
      "Every claim, the artifact that produced it, and the command that regenerates it — including what this build does not claim.",
  },
  "docs/TESTNET-TXS.md": {
    out: "evidence/testnet-transactions",
    title: "Settled transactions",
    description: "Every settled testnet payment, with explorer links.",
  },
  "docs/SEARCH-EVAL.md": {
    out: "evidence/search-eval",
    title: "Search evaluation",
    description: "nDCG@10 0.864 over a 50-query graded set, with method, caveats and a CI regression gate.",
  },
  "docs/LOAD-BASELINE.md": {
    out: "evidence/load-baseline",
    title: "Load baseline",
    description: "4/4 serial vs 1/10 concurrent on a single fee-payer — the before Tranche 1 has to beat.",
  },
  "docs/RFP-ALIGNMENT.md": {
    out: "rfp-alignment",
    title: "RFP alignment",
    description:
      "Every mapped requirement, its status, and the artifact that shows it — including what is not mapped.",
  },
  "docs/upto-position.md": {
    out: "upto-position",
    title: "Position on upto",
    description: "The discovery-side requirements for the Stellar upto scheme, as argued upstream.",
  },
};

// Repo paths that resolve to synced pages get internal links; everything else
// repo-relative goes to GitHub so no reference dies in the projection.
const INTERNAL = new Map(
  Object.entries(PAGES).map(([src, page]) => [src.replace(/^\.\//, ""), `/${page.out}`]),
);

function rewriteLinks(markdown, sourceDir) {
  return markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (whole, target) => {
    const [path, anchor = ""] = target.split("#");
    const fromRoot = resolve(ROOT, sourceDir, path).slice(ROOT.length + 1);
    if (INTERNAL.has(fromRoot)) return `](${INTERNAL.get(fromRoot)}${anchor ? "#" + anchor : ""})`;
    return `](${GITHUB}/${fromRoot}${anchor ? "#" + anchor : ""})`;
  });
}

// MDX treats {…} as an expression and a bare < as JSX. Code spans and fences are safe;
// this escapes only what sits in plain prose, which in these files is rare but fatal.
function mdxEscape(markdown) {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside code
      return part
        .replace(/\{/g, "\\{")
        .replace(/<(?![a-zA-Z/!])/g, "\\<")
        .replace(/<(?=[A-Z])/g, "\\<"); // <STELLARSIGHT_...>-style placeholders
    })
    .join("");
}

let synced = 0;
for (const [src, page] of Object.entries(PAGES)) {
  const raw = readFileSync(resolve(ROOT, src), "utf8");
  const withoutH1 = raw.replace(/^#\s+.*\n+/, "");
  const bodySource = rewriteLinks(withoutH1, dirname(src));
  const body = mdxEscape(bodySource);
  const frontmatter = `---\ntitle: "${page.title}"\ndescription: "${page.description}"\n---\n\n`;
  const outPath = resolve(OUT, `${page.out}.mdx`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, frontmatter + body);
  synced += 1;
}

// Brand assets: same mark the site uses.
mkdirSync(resolve(OUT, "logo"), { recursive: true });
copyFileSync(
  resolve(ROOT, "apps/web/public/assets/stellarsight-mark.svg"),
  resolve(OUT, "logo/stellarsight.svg"),
);
copyFileSync(resolve(ROOT, "apps/web/public/assets/favicon.svg"), resolve(OUT, "favicon.svg"));

console.log(`[docs-site] ${synced} pages projected from canonical markdown into docs-site/`);
