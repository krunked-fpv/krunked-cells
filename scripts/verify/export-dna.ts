// =============================================================================
// KRUNKED CELLS — Stage 2 Mashup DNA Vault Exporter (`npm run export:dna`)
// Copies GAME_DNA.md and dna/genome.json into C:\KrunkedVault\games\krunked-cells\
// and idempotently upserts the Krunked Cells row in C:\KrunkedVault\CATALOG.md.
// Strictly read-only inside C:\krunked-cells (never writes to repo files!).
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

interface GenomeManifest {
  slug: string;
  brandName: string;
  sourceGenre: string;
  simHz: number;
  renderMode: string;
  repoPath: string;
  coreMechanics?: string[];
  spliceableModules?: { id: string; path: string }[];
}

const CATALOG_HEADER =
  '| Krunked Title | Source Genre | Sim/Render | Signature Mechanics & Feel | Spliceable Modules | Local Repo Path |';
const CATALOG_SEPARATOR = '| --- | --- | --- | --- | --- | --- |';

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function buildCatalogRow(genome: GenomeManifest): string {
  const title = escapeMarkdownCell(genome.brandName || 'Krunked Cells');
  const genre = escapeMarkdownCell(genome.sourceGenre || 'roguelite-action-platformer');
  const simRender = escapeMarkdownCell(`${genome.simHz}Hz / ${genome.renderMode}`);
  const mechanics = escapeMarkdownCell(
    'Acrobatic 60Hz platforming (coyote/buffer/wall-run/dive-slam), 24t/21i roll + door smash, 16t shield parry (2.2x crit reflect + 0cd reset), rally HP, 1.15^(n-1) 3-color scrolls, status synergies, 10-kill curse, 3 multi-phase bosses, 0-5BC'
  );
  const modules = escapeMarkdownCell(
    'src/contracts, src/sim/{prng,hash,collision,physics,worldgen,combat,enemies,bosses,roguelite,passage,status}, src/render/WebGL2Renderer, src/assets/ProceduralAtlas, src/audio/AudioEngine, src/input, src/ui, src/app/SaveManager'
  );
  const repoPath = escapeMarkdownCell(genome.repoPath || 'C:\\krunked-cells');

  return `| ${title} | ${genre} | ${simRender} | ${mechanics} | ${modules} | \`${repoPath}\` |`;
}

function upsertCatalogRow(catalogPath: string, brandName: string, row: string): 'created' | 'inserted' | 'updated' {
  if (!fs.existsSync(catalogPath)) {
    const initialContent = [
      '# Krunked Vault — Mashup DNA Catalog',
      '',
      CATALOG_HEADER,
      CATALOG_SEPARATOR,
      row,
      '',
    ].join('\n');
    fs.writeFileSync(catalogPath, initialContent, 'utf8');
    return 'created';
  }

  const raw = fs.readFileSync(catalogPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  // Ensure table header exists
  const hasHeader = lines.some((l) => l.trim().startsWith('| Krunked Title |'));
  if (!hasHeader) {
    const appended = [
      ...lines.filter((l, idx) => idx < lines.length - 1 || l.trim().length > 0),
      '',
      CATALOG_HEADER,
      CATALOG_SEPARATOR,
      row,
      '',
    ].join('\n');
    fs.writeFileSync(catalogPath, appended, 'utf8');
    return 'inserted';
  }

  // Match existing row for this brandName case-insensitively on first column
  const targetPrefix = `| ${brandName.toLowerCase()} |`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.toLowerCase().startsWith(targetPrefix)) {
      lines[i] = row;
      replaced = true;
      break;
    }
  }

  if (replaced) {
    // Deduplicate any accidental extra rows for the same brand
    const deduped: string[] = [];
    let seen = false;
    for (const line of lines) {
      if (line.trim().toLowerCase().startsWith(targetPrefix)) {
        if (seen) continue;
        seen = true;
      }
      deduped.push(line);
    }
    const output = deduped.join('\n').replace(/\n*$/, '\n');
    fs.writeFileSync(catalogPath, output, 'utf8');
    return 'updated';
  }

  // Insert right after the last table row
  let lastTableIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('|')) {
      lastTableIdx = i;
    }
  }
  if (lastTableIdx >= 0) {
    lines.splice(lastTableIdx + 1, 0, row);
  } else {
    lines.push(row);
  }
  const output = lines.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(catalogPath, output, 'utf8');
  return 'inserted';
}

function main(): void {
  const repoRoot = process.cwd();
  const vaultRoot = process.env.KRUNKED_VAULT_DIR?.trim() || 'C:\\KrunkedVault';
  const genomeSrc = path.join(repoRoot, 'dna', 'genome.json');
  const dnaDocSrc = path.join(repoRoot, 'GAME_DNA.md');

  if (!fs.existsSync(genomeSrc)) {
    throw new Error(`Missing required manifest: ${genomeSrc}`);
  }
  if (!fs.existsSync(dnaDocSrc)) {
    throw new Error(`Missing required DNA document: ${dnaDocSrc}`);
  }

  const genomeRaw = fs.readFileSync(genomeSrc, 'utf8');
  const genome = JSON.parse(genomeRaw) as GenomeManifest;
  if (!genome.slug || !genome.brandName || !genome.sourceGenre || !genome.simHz || !genome.renderMode) {
    throw new Error(`Invalid dna/genome.json: missing required top-level fields`);
  }

  const destDir = path.join(vaultRoot, 'games', genome.slug);
  fs.mkdirSync(destDir, { recursive: true });

  const destGenome = path.join(destDir, 'genome.json');
  const destDnaDoc = path.join(destDir, 'GAME_DNA.md');

  fs.copyFileSync(genomeSrc, destGenome);
  fs.copyFileSync(dnaDocSrc, destDnaDoc);

  const catalogPath = path.join(vaultRoot, 'CATALOG.md');
  const row = buildCatalogRow(genome);
  const catalogAction = upsertCatalogRow(catalogPath, genome.brandName, row);

  console.log('====================================================================');
  console.log('KRUNKED CELLS — DNA VAULT EXPORT COMPLETE');
  console.log('====================================================================');
  console.log(`Vault Game Dir:  ${destDir}`);
  console.log(`Copied Files:    GAME_DNA.md, genome.json`);
  console.log(`Catalog Action:  ${catalogAction} row in ${catalogPath}`);
  console.log('====================================================================');
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('[export-dna] Export failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
